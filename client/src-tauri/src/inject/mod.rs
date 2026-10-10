//! Text injection — writes text into the target application.
//!
//! Strategy priority:
//! 1. clipboard + WM_PASTE message (sent directly to target hwnd — works cross-process)
//! 2. clipboard + SendInput Ctrl+V (fallback for apps that don't handle WM_PASTE)
//!
//! Two entry points:
//! - `inject_text_to_hwnd(text, hwnd, focus_hwnd)` — uses pre-probed hwnd (preferred)
//! - `inject_text(text)` — re-captures context (legacy fallback)

use serde::Serialize;

#[cfg(windows)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(windows)]
use std::sync::{Arc, Mutex};
#[cfg(windows)]
use std::time::Instant;

#[cfg(windows)]
static PASTE_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static PASTE_LOCK: Mutex<()> = Mutex::new(());
#[cfg(windows)]
static PENDING_CLIPBOARD: Mutex<Option<PendingClipboard>> = Mutex::new(None);

#[cfg(windows)]
struct ClipboardFormat {
    id: u32,
    bytes: Vec<u8>,
}

#[cfg(windows)]
struct ClipboardSnapshot {
    formats: Vec<ClipboardFormat>,
}

#[cfg(windows)]
struct PendingClipboard {
    paste_id: u64,
    sequence: u32,
    owner_hwnd: isize,
    injected_text: String,
    previous: Arc<ClipboardSnapshot>,
    restoring: bool,
}

#[cfg(windows)]
enum RestoreOutcome {
    Restored,
    Changed,
    Unavailable,
}

#[cfg(windows)]
struct ClipboardRestoreGuard {
    enabled: bool,
    paste_id: u64,
}

#[cfg(windows)]
impl ClipboardRestoreGuard {
    fn new(enabled: bool, paste_id: u64) -> Self {
        Self { enabled, paste_id }
    }
}

#[cfg(windows)]
impl Drop for ClipboardRestoreGuard {
    fn drop(&mut self) {
        if !self.enabled {
            return;
        }

        let paste_id = self.paste_id;
        let scheduled_at = Instant::now();

        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            // Access can stay blocked beyond the initial retry window. Keep
            // trying without holding our mutexes while another application
            // owns the clipboard, until either restoration or a newer copy.
            loop {
                let outcome = {
                    let _paste_lock = PASTE_LOCK.lock().unwrap();
                    let mut pending = PENDING_CLIPBOARD.lock().unwrap();
                    let Some(state) = pending.as_mut().filter(|s| s.paste_id == paste_id) else {
                        return; // Superseded by a newer SayForge paste.
                    };
                    let outcome = unsafe { restore_clipboard_if_unchanged(state) };
                    if !matches!(outcome, RestoreOutcome::Unavailable) {
                        pending.take();
                    }
                    outcome
                };
                if matches!(outcome, RestoreOutcome::Unavailable) {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    continue;
                }
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [inject] clipboard restore finished pasteId={} result={} elapsedMs={}",
                    paste_id,
                    if matches!(outcome, RestoreOutcome::Restored) {
                        "restored"
                    } else {
                        "clipboard_changed"
                    },
                    scheduled_at.elapsed().as_millis()
                ));
                return;
            }
        });
    }
}

#[cfg(windows)]
use windows::Win32::Foundation::HWND;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    SendMessageTimeoutW, SMTO_ABORTIFHUNG,
};
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, KEYBD_EVENT_FLAGS,
};
#[cfg(windows)]
use windows::Win32::System::Threading::GetCurrentThreadId;
#[cfg(windows)]
use windows::Win32::System::DataExchange::{
    OpenClipboard, CloseClipboard, EmptyClipboard, SetClipboardData, GetClipboardData,
    GetOpenClipboardWindow, GetClipboardSequenceNumber, EnumClipboardFormats,
};
#[cfg(windows)]
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GlobalSize, GMEM_MOVEABLE};
#[cfg(windows)]
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, SetLastError, WIN32_ERROR};

use crate::context;

#[derive(Debug, Clone, Serialize, Default)]
pub struct InjectResult {
    pub ok: bool,
    pub strategy: Option<String>,
    pub reason: Option<String>,
    pub detail: Option<String>,
    /// True when SendInput was used on a Chromium-class window without caret —
    /// we can't verify if paste actually landed in an input field.
    #[serde(default)]
    pub uncertain: bool,
}

#[cfg(windows)]
pub fn inject_text_to_hwnd(text: &str, target_hwnd_val: isize, focus_hwnd_val: isize, restore_clipboard: bool, owner_hwnd_val: isize) -> InjectResult {
    let target = HWND(target_hwnd_val as *mut _);
    let focus = if focus_hwnd_val != 0 {
        HWND(focus_hwnd_val as *mut _)
    } else {
        target
    };

    unsafe { do_inject(target, focus, text, restore_clipboard, HWND(owner_hwnd_val as *mut _)) }
}

#[cfg(windows)]
pub fn inject_text(text: &str, restore_clipboard: bool, owner_hwnd_val: isize) -> InjectResult {
    let ctx = context::capture_context("inject");

    if ctx.hwnd.is_empty() || ctx.hwnd == "0" {
        crate::commands::system::write_log_line(&format!(
            "[RUST] [inject] no foreground window hwnd={:?} focusHwnd={:?} process={:?}",
            ctx.hwnd, ctx.focus_hwnd, ctx.process_name
        ));
        return InjectResult {
            ok: false, strategy: None,
            reason: Some("no_foreground_window".to_string()), detail: None,
            uncertain: false,
        };
    }

    let gate = editability_gate(&ctx);
    if !gate.is_editable() {
        return InjectResult {
            ok: false,
            strategy: Some("overlay_fallback".to_string()),
            reason: Some("not_editable".to_string()),
            detail: Some(describe_editability(&ctx, gate)),
            uncertain: false,
        };
    }

    let target_hwnd = ctx.hwnd.parse::<isize>().unwrap_or(0);
    let focus_hwnd = ctx.focus_hwnd.parse::<isize>().unwrap_or(0);
    inject_text_to_hwnd(text, target_hwnd, focus_hwnd, restore_clipboard, owner_hwnd_val)
}

#[cfg(not(windows))]
pub fn inject_text_to_hwnd(_text: &str, _target: isize, _focus: isize, _restore_clipboard: bool, _owner_hwnd_val: isize) -> InjectResult {
    InjectResult { ok: false, strategy: None, reason: Some("not_windows".to_string()), detail: None, uncertain: false }
}
#[cfg(not(windows))]
pub fn inject_text(_text: &str, _restore_clipboard: bool, _owner_hwnd_val: isize) -> InjectResult {
    InjectResult { ok: false, strategy: None, reason: Some("not_windows".to_string()), detail: None, uncertain: false }
}

///
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditableGate {
        ExplorerDesktopReject,
        Caret,
        NativeClass,
        UiaEditableControl,
        UiaRichEditor,
        UiaReadOnly,
        ChromiumOptimistic,
        ProcessAllowlist,
        NoSignal,
}

impl EditableGate {
    pub fn is_editable(self) -> bool {
        !matches!(
            self,
            Self::ExplorerDesktopReject | Self::UiaReadOnly | Self::NoSignal
        )
    }

        pub fn as_str(self) -> &'static str {
        match self {
            Self::ExplorerDesktopReject => "explorer_desktop_reject",
            Self::Caret => "caret",
            Self::NativeClass => "native_class",
            Self::UiaEditableControl => "uia_editable_control",
            Self::UiaRichEditor => "uia_rich_editor",
            Self::UiaReadOnly => "uia_read_only",
            Self::ChromiumOptimistic => "chromium_optimistic",
            Self::ProcessAllowlist => "process_allowlist",
            Self::NoSignal => "no_signal",
        }
    }
}

///
#[cfg(test)]
pub fn is_likely_editable_pub(ctx: &context::AppContext) -> bool {
    editability_gate(ctx).is_editable()
}

pub fn editability_gate(ctx: &context::AppContext) -> EditableGate {
    let fc = ctx.focus_class.to_lowercase();
    let wc = ctx.window_class.to_lowercase();
    let proc = ctx.process_name.to_lowercase();

    let explorer_desktop_classes = ["progman", "workerw", "shelldll_defview", "syslistview32"];
    if proc.contains("explorer")
        && explorer_desktop_classes
            .iter()
            .any(|class_name| fc == *class_name || wc == *class_name)
    {
        return EditableGate::ExplorerDesktopReject;
    }

    if ctx.has_caret { return EditableGate::Caret; }

    // Native Win32 editable controls — always considered editable
    let native_editable_classes = [
        "edit", "richedit", "richedit20w", "richedit50w",
        "scintilla", "texteditorsid",
        // Office Word editor control (used by Outlook, Word, etc.)
        "_wwg",
    ];
    for cls in &native_editable_classes {
        if fc.contains(cls) || wc.contains(cls) { return EditableGate::NativeClass; }
    }

    // UIA-based detection: if control_type is populated, use it as primary signal.
    // This works for both Chromium and native windows.
    if !ctx.control_type.is_empty() {
        let ct = ctx.control_type.as_str();

        // Definitely editable control types
        let is_editable_control = ct == "Edit" || ct == "Document" || ct == "ComboBox";

        // Custom/Group/Pane with ValuePattern (rich text editors like CodeMirror,
        // Notion, Feishu docs, etc.)
        let has_value = ctx.is_value_pattern_available;
        let is_rich_editor = (ct == "Custom" || ct == "Group" || ct == "Pane") && has_value;

        if is_editable_control || is_rich_editor {
            if ctx.is_enabled {
                if ctx.is_read_only == Some(true) {
                    return EditableGate::UiaReadOnly;
                }
                return if is_editable_control {
                    EditableGate::UiaEditableControl
                } else {
                    EditableGate::UiaRichEditor
                };
            }
        }

        // For Chromium windows: if UIA says it's a keyboard-focusable Group/Pane
        // (even without ValuePattern), be optimistic — many web editors
        // (Feishu, Notion, Slack) use contenteditable divs that expose as
        // Group without ValuePattern. SendInput Ctrl+V is harmless if wrong.
        let is_chromium_class = fc.contains("chrome_widgetwin_1")
            || fc.contains("chrome_renderwidgethostview")
            || wc.contains("chrome_widgetwin_1")
            || fc.contains("intermediate d3d window");

        if is_chromium_class && ctx.is_keyboard_focusable && ctx.is_enabled {
            // Optimistic: keyboard-focusable element in Chromium is likely an
            // input area. Only reject known non-editable types.
            let definitely_not_editable = ct == "Button"
                || ct == "MenuItem"
                || ct == "MenuBar"
                || ct == "Menu"
                || ct == "Tab"
                || ct == "TabItem"
                || ct == "ToolBar"
                || ct == "TitleBar"
                || ct == "ScrollBar"
                || ct == "Image"
                || ct == "Hyperlink"
                || ct == "StatusBar"
                || ct == "Header"
                || ct == "HeaderItem"
                || ct == "Separator"
                || ct == "ProgressBar";
            if !definitely_not_editable {
                return EditableGate::ChromiumOptimistic;
            }
        }

        // A process allowlist cannot override explicit evidence that the focused
        // UIA control is disabled, read-only or clearly not an editor.
        if ctx.uia_enabled == Some(false) {
            return EditableGate::NoSignal;
        }
        if ctx.is_read_only == Some(true) {
            return EditableGate::UiaReadOnly;
        }
        if matches!(ct, "Button" | "MenuItem" | "MenuBar" | "Menu" | "Tab" | "TabItem"
            | "ToolBar" | "TitleBar" | "ScrollBar" | "Image" | "Hyperlink"
            | "StatusBar" | "Header" | "HeaderItem" | "Separator" | "ProgressBar") {
            return EditableGate::NoSignal;
        }
        // Unknown UIA controls may still need the legacy process fallback.
    }

    // Includes Qt apps (WeChat/Weixin/DingTalk) and Trae, whose editors may not
    // expose a caret or usable UIA control. Keep these compatibility paths until
    // verified replacements exist; the explicit UIA rejects above take precedence.
    let editable_procs = [
        "notepad", "winword", "excel", "powerpnt", "outlook",
        "code", "devenv", "idea64",
        "trae", "cursor", "windsurf", "kiro",
        "chrome", "msedge", "firefox", "opera", "brave",
        "teams", "wechat", "weixin", "dingtalk", "slack",
        "windowsterminal", "cmd", "powershell",
        "mobaxterm", "putty", "securecrt", "xshell",
    ];
    for p in &editable_procs {
        if proc.contains(p) { return EditableGate::ProcessAllowlist; }
    }
    EditableGate::NoSignal
}

///
pub fn describe_editability(ctx: &context::AppContext, gate: EditableGate) -> String {
    format!(
        "gate={} editable={} class={} focusClass={} hasCaret={} controlType={} valuePattern={} kbFocusable={} enabled={} readOnly={} process={}",
        gate.as_str(),
        gate.is_editable(),
        ctx.window_class,
        ctx.focus_class,
        ctx.has_caret,
        if ctx.control_type.is_empty() { "-" } else { ctx.control_type.as_str() },
        ctx.is_value_pattern_available,
        ctx.is_keyboard_focusable,
        ctx.is_enabled,
        ctx.is_read_only.map_or("-", |v| if v { "true" } else { "false" }),
        ctx.process_name
    )
}

// ─── Core injection logic ───

/// WM_PASTE = 0x0302
#[cfg(windows)]
const WM_PASTE: u32 = 0x0302;

/// WM_COMMAND = 0x0111
#[cfg(windows)]
const WM_COMMAND: u32 = 0x0111;

#[cfg(windows)]
const ID_CONSOLE_PASTE: usize = 0xFFF1;

/// Main injection: try WM_PASTE first, then SendInput Ctrl+V as fallback.
///
#[cfg(windows)]
unsafe fn do_inject(target: HWND, focus: HWND, text: &str, restore_clipboard: bool, clipboard_owner: HWND) -> InjectResult {
    // Serialize clipboard ownership through the full native paste attempt.
    let _paste_lock = PASTE_LOCK.lock().unwrap();
    let paste_id = PASTE_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;

    // Reject closed or unrelated target windows before touching the clipboard.
    if !valid_target_tree(target, focus) {
        return rejected_focus("invalid_target");
    }

    // With protection enabled, capture all supported formats before replacing
    // the clipboard. If a format cannot be backed up, leave it untouched.
    let clipboard_ok = if restore_clipboard {
        let mut pending = PENDING_CLIPBOARD.lock().unwrap();
        match set_clipboard_preserving(text, pending.as_ref(), clipboard_owner) {
            Ok((previous, sequence)) => {
                *pending = Some(PendingClipboard {
                    paste_id,
                    sequence,
                    owner_hwnd: clipboard_owner.0 as isize,
                    injected_text: text.to_owned(),
                    previous,
                    restoring: false,
                });
                true
            }
            Err((why, recovery)) => {
                if let Some((previous, sequence)) = recovery {
                    *pending = Some(PendingClipboard {
                        paste_id,
                        sequence,
                        owner_hwnd: clipboard_owner.0 as isize,
                        injected_text: text.to_owned(),
                        previous,
                        restoring: true,
                    });
                    // The clipboard write failed after EmptyClipboard and the
                    // immediate rollback failed too. Retry later.
                    drop(ClipboardRestoreGuard::new(true, paste_id));
                }
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [inject] clipboard backup failed pasteId={} reason={}", paste_id, why
                ));
                false
            }
        }
    } else {
        PENDING_CLIPBOARD.lock().unwrap().take();
        set_clipboard_with_retry(text, 5, 30)
    };

    if !clipboard_ok {
        let guards = detect_input_guard_software();
        crate::commands::system::write_log_line(&format!(
            "[RUST] [inject] clipboard write failed pasteId={} utf8Len={} utf16Len={} inputGuards={} {}",
            paste_id,
            text.len(),
            text.encode_utf16().count(),
            guards,
            describe_clipboard_holder()
        ));
        return InjectResult {
            ok: false,
            strategy: Some("clipboard".to_string()),
            reason: Some(if restore_clipboard {
                "clipboard_backup_unavailable".to_string()
            } else {
                "clipboard_blocked".to_string()
            }),
            detail: Some(format!(
                "pasteId={} clipboard unavailable or unsafe to replace inputGuards={}",
                paste_id, guards
            )),
            uncertain: false,
        };
    }

    let clipboard_matches = native_get_clipboard_text().as_deref() == Some(text);
    crate::commands::system::write_log_line(&format!(
        "[RUST] [inject] clipboard write ok pasteId={} utf8Len={} utf16Len={} clipboardMatches={} restoreRequested={}",
        paste_id,
        text.len(),
        text.encode_utf16().count(),
        clipboard_matches,
        restore_clipboard
    ));

    let _clipboard_restore_guard = ClipboardRestoreGuard::new(restore_clipboard, paste_id);

    //
    let target_class = crate::context::read_class_name(target).to_lowercase();
    if target_class.contains("consolewindowclass") {
        if !clipboard_still_ours(text, paste_id) {
            return clipboard_changed_result();
        }
        crate::commands::system::write_log_line(
            &format!("[RUST] [inject] console paste attempt hwnd={} class={} textLen={}",
                target.0 as isize, target_class, text.len())
        );

        let fg_ok = GetForegroundWindow() == target || force_foreground(target);
        if !fg_ok {
            return rejected_focus("target_not_foreground");
        }

        let mut result_val: usize = 0;
        let send_ok = SendMessageTimeoutW(
            target,
            WM_COMMAND,
            windows::Win32::Foundation::WPARAM(ID_CONSOLE_PASTE),
            windows::Win32::Foundation::LPARAM(0),
            SMTO_ABORTIFHUNG,
            2000, // 2 second timeout
            Some(&mut result_val),
        );

        // Message delivery does not prove that the console inserted anything.
        // Do not retry automatically: the first attempt may have succeeded.
        return unconfirmed_paste(
            "console_paste",
            format!("hwnd={} delivered={} textLen={}", target.0 as isize, send_ok.0 != 0, text.len()),
        );
    }

    // Step 2: Try WM_PASTE — this is a message sent directly to the target
    // window handle, so it works even if the target is not the foreground
    // window. Most native Win32 controls (Edit, RichEdit) handle it.
    let probed_paste_target = if focus.0 != std::ptr::null_mut() { focus } else { target };
    let paste_target = rebind_invisible_focus(target, probed_paste_target);
    let focus_class = crate::context::read_class_name(paste_target).to_lowercase();

    // WM_PASTE works reliably for native Win32 edit controls
    let try_wm_paste = focus_class.contains("edit")
        || focus_class.contains("richedit")
        || focus_class.contains("scintilla");

    if try_wm_paste {
        return wm_paste_verified(target, paste_target, &focus_class, text, paste_id);
    }

    // Step 3: Fallback — force foreground + SendInput Ctrl+V
    if !clipboard_still_ours(text, paste_id) {
        return clipboard_changed_result();
    }
    let fg_ok = GetForegroundWindow() == target || force_foreground(target);
    crate::commands::system::write_log_line(
        &format!("[RUST] [inject] SendInput fallback target={} fg_ok={} class={} textLen={} {}",
            target.0 as isize, fg_ok, focus_class, text.len(), describe_elevation(target))
    );
    if !fg_ok {
        return rejected_focus("target_not_foreground");
    }

    // Release stuck modifiers
    release_modifiers();
    std::thread::sleep(std::time::Duration::from_millis(15));

    // Set focus to child control if needed
    if focus != target && focus.0 != std::ptr::null_mut() {
        attach_and_set_focus(target, focus);
    }

    if !clipboard_still_ours(text, paste_id) {
        return clipboard_changed_result();
    }
    // SendInput goes to whichever control owns keyboard focus at this instant.
    if !keyboard_focus_is_confirmed(target, focus) {
        return rejected_focus("focus_not_confirmed");
    }

    // SendInput Ctrl+V
    let vk_ctrl = VIRTUAL_KEY(0x11);
    let vk_v = VIRTUAL_KEY(0x56);
    let inputs = [
        make_key_input(vk_ctrl, KEYBD_EVENT_FLAGS(0)),
        make_key_input(vk_v, KEYBD_EVENT_FLAGS(0)),
        make_key_input(vk_v, KEYEVENTF_KEYUP),
        make_key_input(vk_ctrl, KEYEVENTF_KEYUP),
    ];
    let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    let last_err = windows::Win32::Foundation::GetLastError().0;

    std::thread::sleep(std::time::Duration::from_millis(10));
    release_modifiers();

    let detail = format!(
        "sent={} err={} class={} target={} focus={} textLen={} fgOk={}",
        sent, last_err, focus_class, target.0 as isize, focus.0 as isize, text.len(), fg_ok
    );

    if sent >= 4 {
        return unconfirmed_paste("send_input", detail);
    }

    //
    const ERROR_ACCESS_DENIED: u32 = 5;
    let guards = detect_input_guard_software();
    crate::commands::system::write_log_line(&format!(
        "[RUST] [inject] SendInput blocked {} inputGuards={}",
        detail, guards
    ));

    let blocked_by_privilege = sent == 0 && last_err == ERROR_ACCESS_DENIED;
    InjectResult {
        ok: false,
        strategy: Some("send_input".to_string()),
        reason: Some(
            if blocked_by_privilege {
                "input_blocked_access_denied"
            } else {
                "send_input_short_write"
            }
            .to_string(),
        ),
        detail: Some(format!("{} inputGuards={}", detail, guards)),
        uncertain: false,
    }
}

#[cfg(windows)]
fn rejected_focus(reason: &str) -> InjectResult {
    InjectResult {
        ok: false,
        strategy: Some("send_input".to_string()),
        reason: Some(reason.to_string()),
        detail: None,
        uncertain: false,
    }
}

#[cfg(windows)]
fn unconfirmed_paste(strategy: &str, detail: String) -> InjectResult {
    InjectResult {
        ok: false,
        strategy: Some(strategy.to_string()),
        reason: Some("paste_unconfirmed".to_string()),
        detail: Some(detail),
        uncertain: true,
    }
}

#[cfg(any(windows, test))]
fn keyboard_focus_gate(
    target_valid: bool,
    focus_valid: bool,
    foreground_matches: bool,
    focus_matches: bool,
) -> bool {
    target_valid && focus_valid && foreground_matches && focus_matches
}

#[cfg(any(windows, test))]
fn wm_paste_has_observed_effect(delivered: bool, before: Option<usize>, after: Option<usize>) -> bool {
    delivered && matches!((before, after), (Some(start), Some(end)) if start != end)
}

#[cfg(windows)]
unsafe fn valid_target_tree(target: HWND, focus: HWND) -> bool {
    ffi::IsWindow(target) != 0
        && ffi::IsWindowVisible(target) != 0
        && ffi::IsWindowEnabled(target) != 0
        && ffi::IsWindow(focus) != 0
        && ffi::IsWindowEnabled(focus) != 0
        && (focus == target || ffi::IsChild(target, focus) != 0)
}

#[cfg(windows)]
unsafe fn keyboard_focus_is_confirmed(target: HWND, requested: HWND) -> bool {
    let current = current_focus_of(target);
    let focus_valid = current.is_some_and(|hwnd| {
        ffi::IsWindow(hwnd) != 0
            && ffi::IsWindowEnabled(hwnd) != 0
            && ffi::IsWindowVisible(hwnd) != 0
            && (hwnd == target || ffi::IsChild(target, hwnd) != 0)
    });
    let focus_matches = current.is_some_and(|hwnd| {
        if requested == target {
            hwnd == target || ffi::IsChild(target, hwnd) != 0
        } else {
            hwnd == requested
        }
    });
    keyboard_focus_gate(
        valid_target_tree(target, requested),
        focus_valid,
        GetForegroundWindow() == target,
        focus_matches,
    )
}

// ─── Verified WM_PASTE ───

#[cfg(windows)]
const WM_GETTEXTLENGTH: u32 = 0x000E;
#[cfg(windows)]
const GWL_STYLE: i32 = -16;
#[cfg(windows)]
const ES_MULTILINE: i32 = 0x0004;
#[cfg(windows)]
const ES_READONLY: i32 = 0x0800;

#[cfg(windows)]
const VERIFY_QUERY_TIMEOUT_MS: u32 = 150;
#[cfg(windows)]
const VERIFY_WAIT_MS: u64 = 150;

#[cfg(windows)]
mod ffi {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;

    #[link(name = "user32")]
    extern "system" {
        pub fn IsWindow(hwnd: HWND) -> i32;
        pub fn IsWindowVisible(hwnd: HWND) -> i32;
        pub fn IsWindowEnabled(hwnd: HWND) -> i32;
        pub fn GetWindowLongW(hwnd: HWND, index: i32) -> i32;
        pub fn GetDlgCtrlID(hwnd: HWND) -> i32;
        pub fn GetParent(hwnd: HWND) -> HWND;
        pub fn IsChild(parent: HWND, child: HWND) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        pub fn CloseHandle(handle: *mut c_void) -> i32;
        pub fn GetCurrentProcess() -> *mut c_void;
    }

    #[link(name = "advapi32")]
    extern "system" {
        pub fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        pub fn GetTokenInformation(
            token: *mut c_void,
            class: u32,
            info: *mut c_void,
            len: u32,
            ret_len: *mut u32,
        ) -> i32;
    }
}

///
///
///
#[cfg(windows)]
unsafe fn wm_paste_verified(
    target: HWND,
    paste_target: HWND,
    focus_class: &str,
    text: &str,
    paste_id: u64,
) -> InjectResult {
    if !clipboard_still_ours(text, paste_id) {
        return clipboard_changed_result();
    }
    let utf16_len = text.encode_utf16().count();
    let len_before = query_text_len(paste_target);

    crate::commands::system::write_log_line(&format!(
        "[RUST] [inject] WM_PASTE attempt pasteId={} hwnd={} class={} textLen={} utf16Len={} lenBefore={} {} {} clipSeq={} {}",
        paste_id,
        paste_target.0 as isize,
        focus_class,
        text.len(),
        utf16_len,
        fmt_opt(len_before),
        describe_paste_target(target, paste_target),
        describe_elevation(target),
        GetClipboardSequenceNumber(),
        describe_clipboard_holder()
    ));

    // Send exactly once. Neither SendMessageTimeout completion nor an unreadable
    // control proves insertion; retrying can duplicate text in the target.
    let delivered = send_wm_paste(paste_target, paste_id, 1);
    let (len_after, waited_ms) = match (delivered, len_before) {
        (true, Some(before)) => wait_for_text_len_change(paste_target, before),
        _ => (None, 0),
    };
    let detail = format!(
        "hwnd={} class={} delivered={} lenBefore={} lenAfter={} waitedMs={}",
        paste_target.0 as isize,
        focus_class,
        delivered,
        fmt_opt(len_before),
        fmt_opt(len_after),
        waited_ms,
    );
    if wm_paste_has_observed_effect(delivered, len_before, len_after) {
        crate::commands::system::write_log_line(&format!(
            "[RUST] [inject] WM_PASTE verified pasteId={} {}", paste_id, detail
        ));
        return InjectResult {
            ok: true,
            strategy: Some("wm_paste".to_string()),
            reason: None,
            detail: Some(detail),
            uncertain: false,
        };
    }
    unconfirmed_paste("wm_paste", detail)
}

#[cfg(windows)]
unsafe fn send_wm_paste(hwnd: HWND, paste_id: u64, attempt: usize) -> bool {
    let mut result_val: usize = 0;
    let send_ok = SendMessageTimeoutW(
        hwnd,
        WM_PASTE,
        windows::Win32::Foundation::WPARAM(0),
        windows::Win32::Foundation::LPARAM(0),
        SMTO_ABORTIFHUNG,
        2000,
        Some(&mut result_val),
    );
    if send_ok.0 == 0 {
        let err = windows::Win32::Foundation::GetLastError().0;
        crate::commands::system::write_log_line(&format!(
            "[RUST] [inject] WM_PASTE send failed pasteId={} attempt={} err={}",
            paste_id, attempt, err
        ));
        return false;
    }
    true
}

#[cfg(windows)]
unsafe fn query_text_len(hwnd: HWND) -> Option<usize> {
    let mut out: usize = 0;
    let ok = SendMessageTimeoutW(
        hwnd,
        WM_GETTEXTLENGTH,
        windows::Win32::Foundation::WPARAM(0),
        windows::Win32::Foundation::LPARAM(0),
        SMTO_ABORTIFHUNG,
        VERIFY_QUERY_TIMEOUT_MS,
        Some(&mut out),
    );
    if ok.0 == 0 { None } else { Some(out) }
}

#[cfg(windows)]
unsafe fn wait_for_text_len_change(hwnd: HWND, before: usize) -> (Option<usize>, u64) {
    let started = Instant::now();
    loop {
        let now = query_text_len(hwnd);
        let waited_ms = started.elapsed().as_millis() as u64;
        match now {
            Some(n) if n == before && waited_ms < VERIFY_WAIT_MS => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            _ => return (now, waited_ms),
        }
    }
}

#[cfg(windows)]
unsafe fn rebind_invisible_focus(target: HWND, probed: HWND) -> HWND {
    if probed == target || ffi::IsWindowVisible(probed) != 0 {
        return probed;
    }
    let current = current_focus_of(target);
    let usable = current.filter(|cur| {
        *cur != probed
            && ffi::IsWindowVisible(*cur) != 0
            && (*cur == target || ffi::IsChild(target, *cur) != 0)
    });
    crate::commands::system::write_log_line(&format!(
        "[RUST] [inject] probed focus invisible hwnd={} class={} currentFocus={} rebound={}",
        probed.0 as isize,
        crate::context::read_class_name(probed),
        current.map_or(0, |h| h.0 as isize),
        usable.is_some()
    ));
    usable.unwrap_or(probed)
}

#[cfg(windows)]
unsafe fn current_focus_of(target: HWND) -> Option<HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{GetGUIThreadInfo, GUITHREADINFO};
    let tid = GetWindowThreadProcessId(target, None);
    if tid == 0 {
        return None;
    }
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if GetGUIThreadInfo(tid, &mut info).is_err() || info.hwndFocus.0.is_null() {
        return None;
    }
    Some(info.hwndFocus)
}

#[cfg(windows)]
unsafe fn describe_paste_target(target: HWND, paste_target: HWND) -> String {
    let style = ffi::GetWindowLongW(paste_target, GWL_STYLE);
    let parent = ffi::GetParent(paste_target);
    let fg_now = GetForegroundWindow();
    let focus_now = current_focus_of(target);
    format!(
        "visible={} enabled={} readOnly={} multiline={} ctrlId={} parent={}/{} inTarget={} fgIsTarget={} focusNow={} focusUnchanged={}",
        ffi::IsWindowVisible(paste_target) != 0,
        ffi::IsWindowEnabled(paste_target) != 0,
        style & ES_READONLY != 0,
        style & ES_MULTILINE != 0,
        ffi::GetDlgCtrlID(paste_target),
        parent.0 as isize,
        if parent.0.is_null() { String::new() } else { crate::context::read_class_name(parent) },
        paste_target == target || ffi::IsChild(target, paste_target) != 0,
        fg_now == target,
        focus_now.map_or(0, |h| h.0 as isize),
        focus_now == Some(paste_target)
    )
}

#[cfg(windows)]
fn describe_elevation(target: HWND) -> String {
    use std::sync::OnceLock;
    static SELF_ELEVATED: OnceLock<Option<bool>> = OnceLock::new();
    let self_elevated = *SELF_ELEVATED.get_or_init(|| unsafe { token_elevated(ffi::GetCurrentProcess()) });

    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(target, Some(&mut pid)) };
    let target_elevated = if pid == 0 {
        None
    } else {
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        unsafe {
            let process = ffi::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                None
            } else {
                let elevated = token_elevated(process);
                ffi::CloseHandle(process);
                elevated
            }
        }
    };
    format!(
        "selfElevated={} targetElevated={}",
        fmt_bool_opt(self_elevated),
        fmt_bool_opt(target_elevated)
    )
}

#[cfg(windows)]
unsafe fn token_elevated(process: *mut std::ffi::c_void) -> Option<bool> {
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_ELEVATION_CLASS: u32 = 20;
    let mut token: *mut std::ffi::c_void = std::ptr::null_mut();
    if ffi::OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
        return None;
    }
    let mut elevation: u32 = 0;
    let mut ret_len: u32 = 0;
    let ok = ffi::GetTokenInformation(
        token,
        TOKEN_ELEVATION_CLASS,
        &mut elevation as *mut u32 as *mut std::ffi::c_void,
        std::mem::size_of::<u32>() as u32,
        &mut ret_len,
    );
    ffi::CloseHandle(token);
    if ok == 0 { None } else { Some(elevation != 0) }
}

#[cfg(any(windows, test))]
fn fmt_opt(value: Option<usize>) -> String {
    value.map_or_else(|| "?".to_string(), |v| v.to_string())
}

#[cfg(any(windows, test))]
fn fmt_bool_opt(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "true",
        Some(false) => "false",
        None => "?",
    }
}

// ─── Window activation helpers ───

#[cfg(windows)]
unsafe fn force_foreground(target: HWND) -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn AttachThreadInput(id_attach: u32, id_attach_to: u32, f_attach: i32) -> i32;
        fn BringWindowToTop(hwnd: HWND) -> i32;
        fn ShowWindow(hwnd: HWND, n_cmd_show: i32) -> i32;
    }
    const SW_SHOW: i32 = 5;

    let my_tid = GetCurrentThreadId();
    let mut pid: u32 = 0;
    let target_tid = GetWindowThreadProcessId(target, Some(&mut pid));

    let attached = if target_tid != 0 && target_tid != my_tid {
        AttachThreadInput(my_tid, target_tid, 1) != 0
    } else {
        false
    };

    // Use a harmless key (VK_F24 = 0x87) to satisfy SetForegroundWindow's
    // "caller must have received input" requirement. Alt is problematic
    // because its keyup activates menus in many apps.
    let f24_down = make_key_input(VIRTUAL_KEY(0x87), KEYBD_EVENT_FLAGS(0));
    let f24_up = make_key_input(VIRTUAL_KEY(0x87), KEYEVENTF_KEYUP);
    let _ = SendInput(&[f24_down, f24_up], std::mem::size_of::<INPUT>() as i32);

    let _ = ShowWindow(target, SW_SHOW);
    let _ = BringWindowToTop(target);
    let _ = SetForegroundWindow(target);
    std::thread::sleep(std::time::Duration::from_millis(50));

    let fg_ok = GetForegroundWindow() == target;
    if !fg_ok {
        let _ = SetForegroundWindow(target);
        std::thread::sleep(std::time::Duration::from_millis(30));
    }

    if attached {
        AttachThreadInput(my_tid, target_tid, 0);
    }

    GetForegroundWindow() == target
}

#[cfg(windows)]
unsafe fn attach_and_set_focus(target: HWND, focus: HWND) {
    #[link(name = "user32")]
    extern "system" {
        fn AttachThreadInput(id_attach: u32, id_attach_to: u32, f_attach: i32) -> i32;
    }

    let my_tid = GetCurrentThreadId();
    let mut pid: u32 = 0;
    let target_tid = GetWindowThreadProcessId(target, Some(&mut pid));
    let attached = if target_tid != 0 && target_tid != my_tid {
        AttachThreadInput(my_tid, target_tid, 1) != 0
    } else {
        false
    };

    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    let _ = SetFocus(focus);
    std::thread::sleep(std::time::Duration::from_millis(10));

    if attached {
        AttachThreadInput(my_tid, target_tid, 0);
    }
}

// ─── Key input helpers ───

#[cfg(windows)]
fn make_key_input(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(windows)]
unsafe fn release_modifiers() {
    let modifiers: [u16; 6] = [0xA4, 0xA5, 0xA0, 0xA1, 0xA2, 0xA3];
    let inputs: Vec<INPUT> = modifiers.iter().map(|&vk| {
        make_key_input(VIRTUAL_KEY(vk), KEYEVENTF_KEYUP)
    }).collect();
    let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}

// ─── Clipboard helpers ───

// These formats use global memory handles. GDI handles, owner-display and
// private clipboard formats cannot be copied as HGLOBAL; fail without writing.
#[cfg(any(windows, test))]
fn can_snapshot_format(format: u32) -> bool {
    matches!(format, 1 | 4 | 5 | 6 | 7 | 8 | 10 | 11 | 12 | 13 | 15 | 16 | 17)
        || format >= 0xC000 // Registered formats (HTML, RTF, custom MIME data).
}

#[cfg(any(windows, test))]
fn same_clipboard_version(expected: u32, actual: u32, text_matches: bool) -> bool {
    expected != 0 && expected == actual && text_matches
}

#[cfg(any(windows, test))]
fn pending_clipboard_matches(expected: u32, actual: u32, restoring: bool, text_matches: bool) -> bool {
    same_clipboard_version(expected, actual, restoring || text_matches)
}

#[cfg(windows)]
unsafe fn clipboard_still_ours(text: &str, paste_id: u64) -> bool {
    let expected = PENDING_CLIPBOARD.lock().unwrap().as_ref()
        .filter(|state| state.paste_id == paste_id)
        .map(|state| state.sequence);
    if let Some(sequence) = expected {
        if GetClipboardSequenceNumber() != sequence {
            return false;
        }
    }
    native_get_clipboard_text().as_deref() == Some(text)
}

#[cfg(windows)]
fn clipboard_changed_result() -> InjectResult {
    InjectResult {
        ok: false,
        strategy: Some("clipboard".to_string()),
        reason: Some("clipboard_changed".to_string()),
        detail: None,
        uncertain: false,
    }
}

#[cfg(windows)]
unsafe fn allocate_clipboard_bytes(bytes: &[u8]) -> Result<HGLOBAL, String> {
    let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len())
        .map_err(|e| format!("step=GlobalAlloc bytes={} err={e}", bytes.len()))?;
    let ptr = GlobalLock(handle);
    if ptr.is_null() {
        let _ = GlobalFree(handle);
        return Err("step=GlobalLock err=null".to_string());
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
    let _ = GlobalUnlock(handle);
    Ok(handle)
}

#[cfg(windows)]
unsafe fn capture_clipboard_open() -> Result<ClipboardSnapshot, String> {
    const MAX_BACKUP_BYTES: usize = 128 * 1024 * 1024;
    const MAX_FORMATS: usize = 128;
    let mut formats = Vec::new();
    let mut total_bytes = 0usize;
    let mut format = 0u32;
    loop {
        SetLastError(WIN32_ERROR(0));
        format = EnumClipboardFormats(format);
        if format == 0 {
            if windows::Win32::Foundation::GetLastError().0 != 0 {
                return Err("step=EnumClipboardFormats".to_string());
            }
            break;
        }
        if !can_snapshot_format(format) || formats.len() >= MAX_FORMATS {
            return Err(format!("unsupported clipboard format {}", format));
        }
        let data = GetClipboardData(format)
            .map_err(|e| format!("step=GetClipboardData format={} err={e}", format))?;
        let handle = HGLOBAL(data.0);
        let size = GlobalSize(handle);
        if size == 0 || size > MAX_BACKUP_BYTES.saturating_sub(total_bytes) {
            return Err(format!("clipboard format {} is not a bounded HGLOBAL", format));
        }
        let ptr = GlobalLock(handle);
        if ptr.is_null() {
            return Err(format!("step=GlobalLock format={}", format));
        }
        let bytes = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
        let _ = GlobalUnlock(handle);
        total_bytes += size;
        formats.push(ClipboardFormat { id: format, bytes });
    }
    Ok(ClipboardSnapshot { formats })
}

#[cfg(windows)]
// The error flag distinguishes failures before and after EmptyClipboard.
unsafe fn restore_snapshot_open(snapshot: &ClipboardSnapshot) -> Result<(), (String, bool)> {
    // Allocate every block before EmptyClipboard so allocation failures cannot
    // discard the text currently on the clipboard.
    let mut prepared = Vec::with_capacity(snapshot.formats.len());
    for format in &snapshot.formats {
        match allocate_clipboard_bytes(&format.bytes) {
            Ok(handle) => prepared.push((format.id, handle)),
            Err(why) => {
                for (_, handle) in prepared {
                    let _ = GlobalFree(handle);
                }
                return Err((why, false));
            }
        }
    }
    if let Err(err) = EmptyClipboard() {
        for (_, handle) in prepared {
            let _ = GlobalFree(handle);
        }
        return Err((format!("step=EmptyClipboard err={err}"), false));
    }
    for (index, (format, handle)) in prepared.iter().copied().enumerate() {
        if let Err(err) = SetClipboardData(format, HANDLE(handle.0)) {
            for (_, remaining) in prepared.into_iter().skip(index) {
                let _ = GlobalFree(remaining);
            }
            return Err((format!("step=SetClipboardData format={format} err={err}"), true));
        }
    }
    Ok(())
}

#[cfg(windows)]
unsafe fn set_clipboard_preserving(
    text: &str,
    pending: Option<&PendingClipboard>,
    owner: HWND,
) -> Result<(Arc<ClipboardSnapshot>, u32), (String, Option<(Arc<ClipboardSnapshot>, u32)>)> {
    if owner.0.is_null() {
        return Err(("clipboard owner window unavailable".to_string(), None));
    }
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
    let mut replacement = Some(allocate_clipboard_bytes(bytes).map_err(|err| (err, None))?);

    let mut opened = false;
    for attempt in 0..5 {
        if OpenClipboard(owner).is_ok() {
            opened = true;
            break;
        }
        if attempt < 4 {
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }
    if !opened {
        let _ = GlobalFree(replacement.take().unwrap());
        return Err((format!("step=OpenClipboard {}", describe_clipboard_holder()), None));
    }
    let mut recovery = None;
    let result = (|| -> Result<(Arc<ClipboardSnapshot>, u32), String> {
        let current_sequence = GetClipboardSequenceNumber();
        let previous = match pending {
            Some(state) if pending_clipboard_matches(
                state.sequence,
                current_sequence,
                state.restoring,
                !state.restoring && native_get_clipboard_text_open().as_deref() == Some(state.injected_text.as_str()),
            ) => Arc::clone(&state.previous),
            _ => Arc::new(capture_clipboard_open()?),
        };
        EmptyClipboard().map_err(|e| format!("step=EmptyClipboard err={e}"))?;
        let handle = replacement.take().unwrap();
        if let Err(err) = SetClipboardData(13, HANDLE(handle.0)) {
            let _ = GlobalFree(handle);
            // The previous data was already removed; restore it immediately.
            if restore_snapshot_open(&previous).is_err() {
                recovery = Some((Arc::clone(&previous), GetClipboardSequenceNumber()));
            }
            return Err(format!("step=SetClipboardData err={err}"));
        }
        mark_clipboard_history_excluded();
        Ok((previous, GetClipboardSequenceNumber()))
    })();
    let _ = CloseClipboard();
    if let Some(handle) = replacement {
        let _ = GlobalFree(handle);
    }
    result.map_err(|reason| (reason, recovery))
}

#[cfg(windows)]
unsafe fn restore_clipboard_if_unchanged(state: &mut PendingClipboard) -> RestoreOutcome {
    let mut opened = false;
    for attempt in 0..5 {
        if OpenClipboard(HWND(state.owner_hwnd as *mut _)).is_ok() {
            opened = true;
            break;
        }
        if attempt < 4 {
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }
    if !opened {
        return RestoreOutcome::Unavailable;
    }
    let restored = if pending_clipboard_matches(
        state.sequence,
        GetClipboardSequenceNumber(),
        state.restoring,
        !state.restoring && native_get_clipboard_text_open().as_deref() == Some(state.injected_text.as_str()),
    ) {
        match restore_snapshot_open(&state.previous) {
            Ok(()) => RestoreOutcome::Restored,
            Err((reason, modified)) => {
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [inject] clipboard restore failed pasteId={} modified={} reason={}",
                    state.paste_id, modified, reason
                ));
                if modified {
                    // Still holding OpenClipboard: only this restore attempt
                    // caused this version change. Keep the original snapshot
                    // and retry while the clipboard stays at this sequence.
                    state.sequence = GetClipboardSequenceNumber();
                    state.restoring = true;
                }
                RestoreOutcome::Unavailable
            }
        }
    } else {
        RestoreOutcome::Changed
    };
    let _ = CloseClipboard();
    restored
}

///
#[cfg(windows)]
unsafe fn describe_clipboard_holder() -> String {
    let holder = match GetOpenClipboardWindow() {
        Ok(h) if !h.0.is_null() => h,
        _ => return "holder=<none>".to_string(),
    };
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(holder, Some(&mut pid));
    let name = crate::context::get_process_name(pid);
    format!(
        "holder_hwnd={} holder_pid={} holder_process={} holder_class={}",
        holder.0 as isize,
        pid,
        if name.is_empty() { "<unknown>" } else { &name },
        crate::context::read_class_name(holder)
    )
}

///
#[cfg(windows)]
const INPUT_GUARD_PROCESSES: &[&str] = &[
    // Diagnostics only: security tools that may block clipboard or SendInput.
    // Process detection never grants editability or triggers an insertion.
    // 360, QQ, Baidu, and other security tools
    "360tray.exe", "360safe.exe", "zhudongfangyu.exe", "360sd.exe", "360rp.exe",
    "hipstray.exe", "usysdiag.exe", "wsctrlsvc.exe",
    "qqpctray.exe", "qqpcmgr.exe", "qqpcrtp.exe",
    "kxetray.exe", "kislive.exe", "kwsprotect64.exe",
    "lavasoft.exe", "baidusdtray.exe", "avp.exe",
];

#[cfg(windows)]
fn detect_input_guard_software() -> &'static str {
    use std::sync::OnceLock;
    static DETECTED: OnceLock<String> = OnceLock::new();
    DETECTED.get_or_init(|| {
        use windows::Win32::System::ProcessStatus::K32EnumProcesses;
        let mut pids = vec![0u32; 1024];
        let mut needed: u32 = 0;
        let ok = unsafe {
            K32EnumProcesses(
                pids.as_mut_ptr(),
                (pids.len() * std::mem::size_of::<u32>()) as u32,
                &mut needed,
            )
        };
        if !ok.as_bool() {
            return String::from("<enum_failed>");
        }
        let count = needed as usize / std::mem::size_of::<u32>();
        let mut hits: Vec<String> = Vec::new();
        for &pid in pids.iter().take(count) {
            if pid == 0 {
                continue;
            }
            let name = crate::context::get_process_name(pid).to_lowercase();
            if name.is_empty() {
                continue;
            }
            if INPUT_GUARD_PROCESSES.contains(&name.as_str()) && !hits.contains(&name) {
                hits.push(name);
            }
        }
        if hits.is_empty() {
            String::from("<none>")
        } else {
            hits.join(",")
        }
    })
    .as_str()
}

#[cfg(windows)]
unsafe fn set_clipboard_with_retry(text: &str, max_retries: u32, retry_delay_ms: u64) -> bool {
    for attempt in 0..max_retries {
        match native_set_clipboard_text(text) {
            Ok(()) => return true,
            Err(why) => {
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [inject] clipboard set attempt {}/{} failed {}",
                    attempt + 1,
                    max_retries,
                    why
                ));
            }
        }
        if attempt < max_retries - 1 {
            std::thread::sleep(std::time::Duration::from_millis(retry_delay_ms));
        }
    }
    false
}

#[cfg(windows)]
unsafe fn native_set_clipboard_text(text: &str) -> Result<(), String> {
    if OpenClipboard(HWND(std::ptr::null_mut())).is_err() {
        let err = windows::Win32::Foundation::GetLastError().0;
        return Err(format!(
            "step=OpenClipboard err={} {}",
            err,
            describe_clipboard_holder()
        ));
    }

    let result = (|| -> Result<(), String> {
        let _ = EmptyClipboard();
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let byte_len = wide.len() * 2;

        let hmem = match GlobalAlloc(GMEM_MOVEABLE, byte_len) {
            Ok(h) => h,
            Err(e) => return Err(format!("step=GlobalAlloc bytes={} err={}", byte_len, e)),
        };

        let locked = GlobalLock(hmem);
        if locked.is_null() {
            return Err("step=GlobalLock err=null".to_string());
        }

        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, locked as *mut u8, byte_len);
        let _ = GlobalUnlock(hmem);

        // CF_UNICODETEXT = 13
        if let Err(e) = SetClipboardData(13, HANDLE(hmem.0 as *mut _)) {
            let err = windows::Win32::Foundation::GetLastError().0;
            return Err(format!("step=SetClipboardData err={} detail={}", err, e));
        }

        mark_clipboard_history_excluded();

        Ok(())
    })();

    let _ = CloseClipboard();
    result
}

#[cfg(windows)]
unsafe fn mark_clipboard_history_excluded() {
    use windows::core::PCWSTR;
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;

    let write_dword_format = |format_name: &[u16], value: u32| {
        let fmt = RegisterClipboardFormatW(PCWSTR(format_name.as_ptr()));
        if fmt == 0 { return; }
        let hmem = match GlobalAlloc(GMEM_MOVEABLE, 4) {
            Ok(h) => h,
            Err(_) => return,
        };
        let locked = GlobalLock(hmem);
        if locked.is_null() { return; }
        std::ptr::copy_nonoverlapping(&value as *const u32 as *const u8, locked as *mut u8, 4);
        let _ = GlobalUnlock(hmem);
        let _ = SetClipboardData(fmt, HANDLE(hmem.0 as *mut _));
    };

    let hist: Vec<u16> = "CanIncludeInClipboardHistory\0".encode_utf16().collect();
    write_dword_format(&hist, 0);

    let cloud: Vec<u16> = "CanUploadToCloudClipboard\0".encode_utf16().collect();
    write_dword_format(&cloud, 0);

    let exclude: Vec<u16> = "ExcludeClipboardContentFromMonitorProcessing\0".encode_utf16().collect();
    write_dword_format(&exclude, 0);
}

#[cfg(windows)]
pub unsafe fn set_clipboard_with_retry_pub(text: &str, max_retries: u32, retry_delay_ms: u64) -> bool {
    set_clipboard_with_retry(text, max_retries, retry_delay_ms)
}

#[cfg(windows)]
unsafe fn native_get_clipboard_text() -> Option<String> {
    if OpenClipboard(HWND(std::ptr::null_mut())).is_err() { return None; }

    let result = native_get_clipboard_text_open();
    let _ = CloseClipboard();
    result
}

#[cfg(windows)]
unsafe fn native_get_clipboard_text_open() -> Option<String> {
    let result = (|| -> Option<String> {
        let handle = GetClipboardData(13).ok()?; // CF_UNICODETEXT
        let hmem = windows::Win32::Foundation::HGLOBAL(handle.0);
        let locked = GlobalLock(hmem);
        if locked.is_null() { return None; }

        let mut len = 0usize;
        let ptr = locked as *const u16;
        loop {
            if *ptr.add(len) == 0 { break; }
            len += 1;
            if len > 10_000_000 { break; }
        }
        let slice = std::slice::from_raw_parts(ptr, len);
        let text = String::from_utf16_lossy(slice);
        let _ = GlobalUnlock(hmem);
        Some(text)
    })();
    result
}

#[cfg(test)]
mod tests {
    use super::{
        can_snapshot_format, describe_editability, editability_gate, is_likely_editable_pub,
        keyboard_focus_gate, pending_clipboard_matches, same_clipboard_version,
        wm_paste_has_observed_effect, EditableGate,
    };
    use crate::context::AppContext;

    #[test]
    fn clipboard_backup_accepts_hglobal_text_image_files_and_registered_formats() {
        for format in [1, 8, 13, 15, 16, 17, 0xC001] {
            assert!(can_snapshot_format(format), "format {format}");
        }
    }

    #[test]
    fn clipboard_backup_rejects_gdi_owner_display_and_private_handles() {
        for format in [0, 2, 3, 9, 14, 0x80, 0x81, 0x200, 0x300] {
            assert!(!can_snapshot_format(format), "format {format}");
        }
    }

    #[test]
    fn clipboard_restore_requires_exact_generation_and_unchanged_text() {
        assert!(same_clipboard_version(41, 41, true));
        assert!(!same_clipboard_version(41, 42, true)); // User copied the same text anew.
        assert!(!same_clipboard_version(41, 41, false));
        assert!(!same_clipboard_version(0, 0, true)); // No reliable sequence number.
    }

    #[test]
    fn partial_restore_retry_accepts_only_our_updated_sequence() {
        // A failed write can leave an empty or partially restored clipboard
        // without our injected text, but only our own sequence is reusable.
        assert!(pending_clipboard_matches(42, 42, true, false));
        assert!(!pending_clipboard_matches(42, 43, true, false));
        assert!(!pending_clipboard_matches(42, 42, false, false));
        assert!(pending_clipboard_matches(42, 42, false, true));
    }

    #[test]
    fn keyboard_shortcut_requires_valid_target_and_current_focus() {
        assert!(keyboard_focus_gate(true, true, true, true));
        assert!(!keyboard_focus_gate(false, true, true, true)); // Closed target.
        assert!(!keyboard_focus_gate(true, false, true, true)); // Invalid focused control.
        assert!(!keyboard_focus_gate(true, true, false, true)); // Foreground activation failed.
        assert!(!keyboard_focus_gate(true, true, true, false)); // Focus shifted elsewhere.
    }

    #[test]
    fn wm_paste_must_observe_changed_text_length() {
        assert!(wm_paste_has_observed_effect(true, Some(5), Some(10)));
        assert!(!wm_paste_has_observed_effect(false, Some(5), Some(10)));
        assert!(!wm_paste_has_observed_effect(true, Some(5), Some(5)));
        assert!(!wm_paste_has_observed_effect(true, None, Some(10)));
        assert!(!wm_paste_has_observed_effect(true, Some(5), None));
    }

            fn weixin_4x_ctx(process_name: &str) -> AppContext {
        AppContext {
            process_name: process_name.to_string(),
            window_class: "Qt51514QWindowIcon".to_string(),
            focus_class: "Qt51514QWindowIcon".to_string(),
            has_caret: false,
            control_type: "Window".to_string(),
            is_value_pattern_available: false,
            is_keyboard_focusable: false,
            is_enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn weixin_4x_is_editable_via_process_allowlist() {
        //
        let ctx = weixin_4x_ctx("Weixin.exe");
        assert_eq!(editability_gate(&ctx), EditableGate::ProcessAllowlist);
        assert!(is_likely_editable_pub(&ctx));
    }

    #[test]
    fn wechat_3x_name_still_editable() {
        assert_eq!(
            editability_gate(&weixin_4x_ctx("WeChat.exe")),
            EditableGate::ProcessAllowlist
        );
        assert_eq!(
            editability_gate(&weixin_4x_ctx("wechatdevtools.exe")),
            EditableGate::ProcessAllowlist
        );
    }

    #[test]
    fn vendor_editors_keep_fallback_when_uia_cannot_identify_the_editor() {
        for name in ["Weixin.exe", "WeChat.exe", "DingTalk.exe", "Trae.exe"] {
            assert_eq!(editability_gate(&weixin_4x_ctx(name)), EditableGate::ProcessAllowlist);
        }
    }

    #[test]
    fn vendor_allowlist_does_not_override_explicit_noneditable_uia_controls() {
        for name in ["Weixin.exe", "WeChat.exe", "DingTalk.exe", "Trae.exe"] {
            let mut ctx = weixin_4x_ctx(name);
            ctx.control_type = "Button".to_string();
            assert_eq!(editability_gate(&ctx), EditableGate::NoSignal, "{name}");

            ctx.control_type = "Window".to_string();
            ctx.is_enabled = false;
            ctx.uia_enabled = Some(false);
            assert_eq!(editability_gate(&ctx), EditableGate::NoSignal, "{name}");

            ctx.is_enabled = true;
            ctx.uia_enabled = Some(true);
            ctx.is_read_only = Some(true);
            assert_eq!(editability_gate(&ctx), EditableGate::UiaReadOnly, "{name}");
        }
    }

    #[test]
    fn vendor_fallback_accepts_unknown_uia_enabled_without_claiming_disabled() {
        for name in ["Weixin.exe", "WeChat.exe", "DingTalk.exe", "Trae.exe"] {
            let mut ctx = weixin_4x_ctx(name);
            ctx.is_enabled = false; // Default for unavailable UIA IsEnabled property.
            ctx.uia_enabled = None;
            assert_eq!(editability_gate(&ctx), EditableGate::ProcessAllowlist, "{name}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn input_guard_processes_are_detected_by_exact_executable_name() {
        assert!(super::INPUT_GUARD_PROCESSES.contains(&"360safe.exe"));
        assert!(super::INPUT_GUARD_PROCESSES.contains(&"qqpctray.exe"));
        assert!(super::INPUT_GUARD_PROCESSES.contains(&"baidusdtray.exe"));
        assert!(!super::INPUT_GUARD_PROCESSES.contains(&"not_360safe.exe"));
    }

                #[test]
    fn unknown_qt_app_falls_through_all_gates() {
        let ctx = weixin_4x_ctx("qbittorrent.exe");
        assert_eq!(editability_gate(&ctx), EditableGate::NoSignal);
        assert!(!is_likely_editable_pub(&ctx));
    }

            #[test]
    fn explorer_desktop_is_rejected_before_caret() {
        let ctx = AppContext {
            process_name: "explorer.exe".to_string(),
            window_class: "Progman".to_string(),
            focus_class: "SysListView32".to_string(),
            has_caret: true,
            is_enabled: true,
            ..Default::default()
        };
        assert_eq!(editability_gate(&ctx), EditableGate::ExplorerDesktopReject);
        assert!(!is_likely_editable_pub(&ctx));
    }

            #[test]
    fn describe_editability_never_leaks_title_or_path() {
        let mut ctx = weixin_4x_ctx("Weixin.exe");
        ctx.window_title = "Confidential quarter-end bonuses".to_string();
        ctx.exe_path = r"C:\Users\sample-user\AppData\Local\Programs\Weixin.exe".to_string();

        let line = describe_editability(&ctx, editability_gate(&ctx));

        assert!(!line.contains("quarter-end bonuses"), "window title leaked: {line}");
        assert!(!line.contains("sample-user"), "exe path leaked: {line}");
        assert!(line.contains("gate=process_allowlist"), "{line}");
        assert!(line.contains("process=Weixin.exe"), "{line}");
        assert!(line.contains("focusClass=Qt51514QWindowIcon"), "{line}");
    }
}
