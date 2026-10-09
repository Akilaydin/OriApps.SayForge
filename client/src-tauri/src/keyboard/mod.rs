//! Global keyboard hook for PTT (Push-to-Talk) functionality.
//!
//! Uses Win32 SetWindowsHookExW(WH_KEYBOARD_LL) to capture key events globally.
//! Runs the message loop on a dedicated thread.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

static LAST_CALLBACK_MS: AtomicI64 = AtomicI64::new(0);
static DISPATCHER_ALIVE: AtomicBool = AtomicBool::new(false);
static TRY_SEND_FAIL_COUNT: AtomicU64 = AtomicU64::new(0);
static MAX_CALLBACK_DURATION_US: AtomicU64 = AtomicU64::new(0);
static HOOK_RUNNING: AtomicBool = AtomicBool::new(false);
static RECONFIGURE_COUNT: AtomicU64 = AtomicU64::new(0);

static SHORTCUT_CAPTURE: AtomicBool = AtomicBool::new(false);
static CONSUME_XUP_VK: AtomicU32 = AtomicU32::new(0);

pub fn set_shortcut_capture(on: bool) {
    SHORTCUT_CAPTURE.store(on, Ordering::SeqCst);
    if on {
        CONSUME_XUP_VK.store(0, Ordering::SeqCst);
    }
}

const ESCAPE_MODE_OFF: u32 = 0;
const ESCAPE_MODE_CANCEL_PROCESSING: u32 = 1;
const ESCAPE_MODE_DISMISS_FALLBACK: u32 = 2;
const ESCAPE_MODE_CANCEL_RECORDING: u32 = 3;
const ESCAPE_MODE_ABANDON_LATE_RESULT: u32 = 4;
static ESCAPE_ACTION_MODE: AtomicU32 = AtomicU32::new(ESCAPE_MODE_OFF);
static ESCAPE_ACTION_TOKEN: AtomicU64 = AtomicU64::new(0);
static ESCAPE_ACTION_DEADLINE_MS: AtomicI64 = AtomicI64::new(0);
static ESCAPE_KEY_DOWN: AtomicBool = AtomicBool::new(false);

pub fn set_escape_action_mode(mode: &str, token: u64) -> Result<(), String> {
    let (value, ttl_ms) = match mode {
        "off" => (ESCAPE_MODE_OFF, 0),
        "cancel_recording" => (ESCAPE_MODE_CANCEL_RECORDING, 11 * 60 * 1000),
        "cancel_processing" => (ESCAPE_MODE_CANCEL_PROCESSING, 2 * 60 * 1000),
        "dismiss_fallback" => (ESCAPE_MODE_DISMISS_FALLBACK, 30 * 1000),
        "abandon_late_result" => (ESCAPE_MODE_ABANDON_LATE_RESULT, 60 * 1000),
        _ => return Err(format!("Unknown Escape action mode: {mode}")),
    };
    ESCAPE_ACTION_MODE.store(ESCAPE_MODE_OFF, Ordering::SeqCst);
    ESCAPE_ACTION_TOKEN.store(if value == ESCAPE_MODE_OFF { 0 } else { token }, Ordering::SeqCst);
    ESCAPE_ACTION_DEADLINE_MS.store(
        if value == ESCAPE_MODE_OFF { 0 } else { now_ms() + ttl_ms },
        Ordering::SeqCst,
    );
    ESCAPE_ACTION_MODE.store(value, Ordering::SeqCst);
    Ok(())
}

fn active_escape_action() -> (u32, u64) {
    let mode = ESCAPE_ACTION_MODE.load(Ordering::SeqCst);
    if mode == ESCAPE_MODE_OFF {
        return (ESCAPE_MODE_OFF, 0);
    }
    if now_ms() > ESCAPE_ACTION_DEADLINE_MS.load(Ordering::SeqCst) {
        ESCAPE_ACTION_MODE.store(ESCAPE_MODE_OFF, Ordering::SeqCst);
        ESCAPE_ACTION_TOKEN.store(0, Ordering::SeqCst);
        ESCAPE_ACTION_DEADLINE_MS.store(0, Ordering::SeqCst);
        return (ESCAPE_MODE_OFF, 0);
    }
    (mode, ESCAPE_ACTION_TOKEN.load(Ordering::SeqCst))
}

fn escape_action_mode_name(mode: u32) -> &'static str {
    match mode {
        ESCAPE_MODE_CANCEL_RECORDING => "cancel_recording",
        ESCAPE_MODE_CANCEL_PROCESSING => "cancel_processing",
        ESCAPE_MODE_DISMISS_FALLBACK => "dismiss_fallback",
        ESCAPE_MODE_ABANDON_LATE_RESULT => "abandon_late_result",
        _ => "off",
    }
}

//
//
const CARD_HOTKEY_COPY: u32 = 1 << 0;

static CARD_HOTKEY_MASK: AtomicU32 = AtomicU32::new(0);
static CARD_HOTKEY_TOKEN: AtomicU64 = AtomicU64::new(0);
static CARD_HOTKEY_DEADLINE_MS: AtomicI64 = AtomicI64::new(0);
static CARD_HOTKEY_FOREGROUND: AtomicIsize = AtomicIsize::new(0);
static CARD_HOTKEY_C_DOWN: AtomicBool = AtomicBool::new(false);

///
const CARD_HOTKEY_TTL_MS: i64 = 20 * 1000;

pub fn set_card_hotkeys(actions: &[String], token: u64) -> Result<(), String> {
    let mut mask = 0u32;
    for action in actions {
        match action.as_str() {
            "copy" => mask |= CARD_HOTKEY_COPY,
            other => return Err(format!("Unknown card hotkey action: {other}")),
        }
    }

    if mask == 0 {
        CARD_HOTKEY_MASK.store(0, Ordering::SeqCst);
        CARD_HOTKEY_TOKEN.store(0, Ordering::SeqCst);
        CARD_HOTKEY_DEADLINE_MS.store(0, Ordering::SeqCst);
        CARD_HOTKEY_FOREGROUND.store(0, Ordering::SeqCst);
        return Ok(());
    }

    let renewing = CARD_HOTKEY_TOKEN.load(Ordering::SeqCst) == token
        && CARD_HOTKEY_MASK.load(Ordering::SeqCst) != 0;
    if !renewing {
        CARD_HOTKEY_FOREGROUND.store(current_foreground_hwnd(), Ordering::SeqCst);
    }

    CARD_HOTKEY_MASK.store(0, Ordering::SeqCst);
    CARD_HOTKEY_TOKEN.store(token, Ordering::SeqCst);
    CARD_HOTKEY_DEADLINE_MS.store(now_ms() + CARD_HOTKEY_TTL_MS, Ordering::SeqCst);
    CARD_HOTKEY_MASK.store(mask, Ordering::SeqCst);
    Ok(())
}

#[cfg(windows)]
fn current_foreground_hwnd() -> isize {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow().0 as isize }
}

#[cfg(not(windows))]
fn current_foreground_hwnd() -> isize {
    0
}

fn active_card_hotkeys() -> (u32, u64) {
    let mask = CARD_HOTKEY_MASK.load(Ordering::SeqCst);
    if mask == 0 {
        return (0, 0);
    }
    if now_ms() > CARD_HOTKEY_DEADLINE_MS.load(Ordering::SeqCst) {
        CARD_HOTKEY_MASK.store(0, Ordering::SeqCst);
        CARD_HOTKEY_TOKEN.store(0, Ordering::SeqCst);
        CARD_HOTKEY_DEADLINE_MS.store(0, Ordering::SeqCst);
        CARD_HOTKEY_FOREGROUND.store(0, Ordering::SeqCst);
        return (0, 0);
    }
    (mask, CARD_HOTKEY_TOKEN.load(Ordering::SeqCst))
}

#[cfg(windows)]
fn card_hotkey_foreground_matches() -> bool {
    let expected = CARD_HOTKEY_FOREGROUND.load(Ordering::SeqCst);
    if expected == 0 {
        return true;
    }
    current_foreground_hwnd() == expected
}

///
///
#[cfg(windows)]
unsafe fn only_ctrl_is_down(kb_flags: u32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    const VK_CONTROL: i32 = 0x11;
    const VK_SHIFT: i32 = 0x10;
    const VK_MENU: i32 = 0x12;
    const VK_LWIN: i32 = 0x5B;
    const VK_RWIN: i32 = 0x5C;

    if GetAsyncKeyState(VK_CONTROL) >= 0 {
        return false;
    }
    if kb_flags & LLKHF_ALTDOWN != 0 {
        return false;
    }
    for vk in [VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN] {
        if GetAsyncKeyState(vk) < 0 {
            return false;
        }
    }
    true
}

fn card_hotkey_action_name(action: u32) -> &'static str {
    match action {
        CARD_HOTKEY_COPY => "copy",
        _ => "unknown",
    }
}

static WD_LAST_LOG_MS: AtomicI64 = AtomicI64::new(0);
static WD_LAST_HOOK_RUNNING: AtomicBool = AtomicBool::new(false);
static WD_LAST_DISPATCHER_ALIVE: AtomicBool = AtomicBool::new(false);
static WD_LAST_FAIL_COUNT: AtomicU64 = AtomicU64::new(0);
const WD_HEARTBEAT_MS: i64 = 10 * 60 * 1000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(windows)]
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
    GetMessageW, TranslateMessage, DispatchMessageW,
    KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
    WM_SYSKEYDOWN, WM_SYSKEYUP, WM_QUIT,
    MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_XBUTTONDOWN, WM_XBUTTONUP,
    WM_MBUTTONDOWN, WM_MBUTTONUP,
};

///
const SINGLE_KEY_TABLE: &[(&str, u32)] = &[
    ("AltLeft", 0xA4),
    ("AltRight", 0xA5),
    ("ControlLeft", 0xA2),
    ("ControlRight", 0xA3),
    ("ShiftLeft", 0xA0),
    ("ShiftRight", 0xA1),
    ("CapsLock", 0x14),
    ("Space", 0x20),
    ("ContextMenu", 0x5D),
    ("Pause", 0x13),
    ("ScrollLock", 0x91),
    ("Insert", 0x2D),
    ("XButton1", 0x05),
    ("XButton2", 0x06),
    ("MButton", 0x04),
    ("BrowserBack", 0xA6),
    ("BrowserForward", 0xA7),
    ("F1", 0x70), ("F2", 0x71), ("F3", 0x72), ("F4", 0x73),
    ("F5", 0x74), ("F6", 0x75), ("F7", 0x76), ("F8", 0x77),
    ("F9", 0x78), ("F10", 0x79), ("F11", 0x7A), ("F12", 0x7B),
    ("F13", 0x7C), ("F14", 0x7D), ("F15", 0x7E), ("F16", 0x7F),
    ("F17", 0x80), ("F18", 0x81), ("F19", 0x82), ("F20", 0x83),
    ("F21", 0x84), ("F22", 0x85), ("F23", 0x86), ("F24", 0x87),
];

fn ptt_modifier_family(code: &str) -> Option<&'static str> {
    if code.starts_with("Alt") {
        Some("Alt")
    } else if code.starts_with("Control") {
        Some("Control")
    } else if code.starts_with("Shift") {
        Some("Shift")
    } else if code.starts_with("Meta") {
        Some("Meta")
    } else {
        None
    }
}

fn vk_for_ptt_code(code: &str) -> Option<u32> {
    if let Some((_, vk)) = SINGLE_KEY_TABLE.iter().find(|(setting, _)| *setting == code) {
        return Some(*vk);
    }

    if let Some(letter) = code.strip_prefix("Key") {
        let bytes = letter.as_bytes();
        if bytes.len() == 1 && bytes[0].is_ascii_uppercase() {
            return Some(bytes[0] as u32);
        }
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        let bytes = digit.as_bytes();
        if bytes.len() == 1 && bytes[0].is_ascii_digit() {
            return Some(bytes[0] as u32);
        }
    }

    match code {
        "MetaLeft" => Some(0x5B),
        "MetaRight" => Some(0x5C),
        "Escape" => Some(0x1B),
        "Tab" => Some(0x09),
        "Enter" => Some(0x0D),
        "Backspace" => Some(0x08),
        "Delete" => Some(0x2E),
        "ArrowUp" => Some(0x26),
        "ArrowDown" => Some(0x28),
        "ArrowLeft" => Some(0x25),
        "ArrowRight" => Some(0x27),
        "Home" => Some(0x24),
        "End" => Some(0x23),
        "PageUp" => Some(0x21),
        "PageDown" => Some(0x22),
        _ => None,
    }
}

struct PttKeyConfig {
    setting: String,
    vk_codes: Vec<u32>,
    modifier_mask: u64,
}

impl PttKeyConfig {
    fn disabled() -> Self {
        Self {
            setting: String::new(),
            vk_codes: Vec::new(),
            modifier_mask: 0,
        }
    }

    fn fallback() -> Self {
        Self {
            setting: DEFAULT_PTT_SETTING.to_string(),
            vk_codes: vec![DEFAULT_PTT_VK],
            modifier_mask: 1,
        }
    }
}

///
///
const DEFAULT_PTT_SETTING: &str = "ControlRight";
const DEFAULT_PTT_VK: u32 = 0xA3;

///
fn ptt_key_config(setting: &str) -> PttKeyConfig {
    if setting.is_empty() {
        return PttKeyConfig::disabled();
    }

    let codes: Vec<&str> = setting.split('+').collect();
    if codes.is_empty() || codes.len() > 63 || codes.iter().any(|code| code.is_empty()) {
        return PttKeyConfig::fallback();
    }

    let mut vk_codes = Vec::with_capacity(codes.len());
    let mut modifier_mask = 0_u64;
    let mut modifier_families = Vec::new();
    for (index, code) in codes.iter().enumerate() {
        let Some(vk) = vk_for_ptt_code(code) else {
            return PttKeyConfig::fallback();
        };
        if vk_codes.contains(&vk) {
            return PttKeyConfig::fallback();
        }
        vk_codes.push(vk);
        if let Some(family) = ptt_modifier_family(code) {
            if modifier_families.contains(&family) {
                return PttKeyConfig::fallback();
            }
            modifier_families.push(family);
            modifier_mask |= 1_u64 << index;
        }
    }

    let mouse_member = codes
        .iter()
        .any(|code| matches!(*code, "XButton1" | "XButton2" | "MButton"));
    let main_key_count = codes.len() - modifier_mask.count_ones() as usize;
    let valid_shape = if codes.len() == 1 {
        SINGLE_KEY_TABLE.iter().any(|(single, _)| single == &codes[0])
    } else {
        !mouse_member
            && main_key_count <= 1
            && ((main_key_count == 0 && codes.len() >= 2)
                || (main_key_count == 1 && modifier_mask != 0))
    };
    if !valid_shape {
        return PttKeyConfig::fallback();
    }

    PttKeyConfig {
        setting: setting.to_string(),
        vk_codes,
        modifier_mask,
    }
}

/// Virtual key code mapping for PTT settings.
fn vk_codes_for_setting(setting: &str) -> Vec<u32> {
    ptt_key_config(setting).vk_codes
}

/// Check if a shortcut setting is a single key (handled by hook) vs combo (handled by global_shortcut).
pub fn is_single_key_setting(setting: &str) -> bool {
    SINGLE_KEY_TABLE.iter().any(|(single, _)| *single == setting)
}

fn is_mouse_button_setting(setting: &str) -> bool {
    matches!(setting, "XButton1" | "XButton2" | "MButton")
}

///
///
fn is_mouse_vk(vk: u32) -> bool {
    matches!(vk, 0x04 | 0x05 | 0x06)
}

///
fn is_injection_exempt_vk(vk: u32) -> bool {
    matches!(vk, 0xA6 | 0xA7) || (0x7C..=0x87).contains(&vk)
}

///
#[cfg(windows)]
const LLKHF_ALTDOWN: u32 = 0x20;

const MODIFIER_VK_CODES: [u32; 8] = [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C];

///
///
///
fn single_key_requires_bare_press(vk: u32) -> bool {
    !MODIFIER_VK_CODES.contains(&vk) && !is_mouse_vk(vk)
}

///
#[cfg(windows)]
unsafe fn single_key_blocked_by_modifiers(vk: u32, kb_flags: u32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    if !single_key_requires_bare_press(vk) {
        return false;
    }
    if kb_flags & LLKHF_ALTDOWN != 0 {
        return true;
    }
    MODIFIER_VK_CODES
        .iter()
        .any(|code| GetAsyncKeyState(*code as i32) < 0)
}

#[allow(dead_code)]
fn modifier_kind(setting: &str) -> Option<&'static str> {
    match setting {
        "AltLeft" | "AltRight" => Some("alt"),
        "ControlLeft" | "ControlRight" => Some("ctrl"),
        "ShiftLeft" | "ShiftRight" => Some("shift"),
        "MetaLeft" | "MetaRight" => Some("meta"),
        _ => None,
    }
}

#[derive(Clone, Serialize)]
struct PTTEvent {
    source: String,
    reason: String,
    #[serde(rename = "keycode")]
    vk: u32,
    #[serde(rename = "pttSetting")]
    ptt_setting: String,
    timestamp: i64,
    #[serde(rename = "altKey")]
    alt_key: bool,
    #[serde(rename = "ctrlKey")]
    ctrl_key: bool,
    #[serde(rename = "shiftKey")]
    shift_key: bool,
    #[serde(rename = "metaKey")]
    meta_key: bool,
}

/// Shared state between the hook callback and the main thread
struct HookSharedState {
    ptt_vk_codes: Vec<u32>,
    ptt_setting: String,
        ptt_pressed_mask: AtomicU64,
    ptt_full_mask: u64,
        ptt_modifier_mask: u64,
        ptt_consumed_down_mask: AtomicU64,
            ptt_active_generation: AtomicU64,
        ptt_generation: AtomicU64,
            ptt_last_down_ms: Vec<AtomicI64>,
        ptt_hook_alive: AtomicBool,
    hands_free_active: AtomicBool,
            hf_key_down: AtomicBool,
    /// VK codes for hands-free toggle key (empty = not using hook for hands-free)
    hf_vk_codes: Vec<u32>,
    hf_setting: String,
        ai_toggle_key_down: AtomicBool,
    ai_toggle_vk_codes: Vec<u32>,
    ai_toggle_setting: String,
    app_handle: AppHandle,
}

/// Message sent from the hook callback (non-blocking) to the dispatcher thread.
#[cfg(windows)]
#[allow(dead_code)]
enum HookAction {
    PttDown { vk: u32, gen: u64 },
    PttUp { vk: u32, gen: u64, reason: &'static str },
    HfToggle { vk: u32 },
    AiToggle { vk: u32 },
    Escape { mode: u32, token: u64 },
        CardHotkey { action: u32, token: u64 },
    Diag { vk: u32, msg_name: &'static str, flags: u32, scan_code: u32 },
    Shutdown,
        MouseCaptured { vk: u32 },
}

const PTT_RELEASING_BIT: u64 = 1 << 63;

fn begin_ptt_press(active_generation: &AtomicU64, generation: &AtomicU64) -> Option<u64> {
    if active_generation.load(Ordering::SeqCst) != 0 {
        return None;
    }

    let mut gen = generation
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1)
        & !PTT_RELEASING_BIT;
    if gen == 0 {
        gen = generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1)
            & !PTT_RELEASING_BIT;
    }

    active_generation
        .compare_exchange(0, gen, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| gen)
}

fn begin_hf_press(key_down: &AtomicBool) -> bool {
    !key_down.swap(true, Ordering::SeqCst)
}

fn end_hf_press(key_down: &AtomicBool) -> bool {
    key_down.swap(false, Ordering::SeqCst)
}

fn claim_ptt_release(
    active_generation: &AtomicU64,
    expected_generation: Option<u64>,
) -> Option<u64> {
    loop {
        let active = active_generation.load(Ordering::SeqCst);
        if active == 0 || (active & PTT_RELEASING_BIT) != 0 {
            return None;
        }
        if expected_generation.is_some_and(|expected| expected != active) {
            return None;
        }
        if active_generation
            .compare_exchange(
                active,
                active | PTT_RELEASING_BIT,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            return Some(active);
        }
    }
}

fn complete_ptt_release(active_generation: &AtomicU64, gen: u64) -> bool {
    active_generation
        .compare_exchange(
            gen | PTT_RELEASING_BIT,
            0,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_ok()
}

fn clear_ptt_press(active_generation: &AtomicU64) -> Option<u64> {
    let gen = claim_ptt_release(active_generation, None)?;
    let _ = complete_ptt_release(active_generation, gen);
    Some(gen)
}

fn cancel_ptt_press_start(active_generation: &AtomicU64, gen: u64) {
    let _ = active_generation.compare_exchange(gen, 0, Ordering::SeqCst, Ordering::SeqCst);
}

fn ptt_member_index(vk_codes: &[u32], vk: u32) -> Option<usize> {
    vk_codes.iter().position(|configured| *configured == vk)
}

fn press_ptt_member(pressed_mask: &AtomicU64, index: usize, full_mask: u64) -> bool {
    let bit = 1_u64 << index;
    let previous = pressed_mask.fetch_or(bit, Ordering::SeqCst);
    (previous & bit) == 0 && (previous | bit) == full_mask
}

fn release_ptt_member(pressed_mask: &AtomicU64, index: usize) -> bool {
    let bit = 1_u64 << index;
    (pressed_mask.fetch_and(!bit, Ordering::SeqCst) & bit) != 0
}

fn should_consume_combo_main_down(
    pressed_mask: u64,
    consumed_down_mask: u64,
    member_bit: u64,
    modifier_mask: u64,
) -> bool {
    if pressed_mask & member_bit != 0 {
        consumed_down_mask & member_bit != 0
    } else {
        pressed_mask & modifier_mask == modifier_mask
    }
}

fn clear_ptt_members(state: &HookSharedState) {
    state.ptt_pressed_mask.store(0, Ordering::SeqCst);
    state.ptt_consumed_down_mask.store(0, Ordering::SeqCst);
}

fn ptt_modifier_flags(setting: &str) -> (bool, bool, bool, bool) {
    let codes = setting.split('+');
    let mut alt = false;
    let mut ctrl = false;
    let mut shift = false;
    let mut meta = false;
    for code in codes {
        alt |= code.starts_with("Alt");
        ctrl |= code.starts_with("Control");
        shift |= code.starts_with("Shift");
        meta |= code.starts_with("Meta");
    }
    (alt, ctrl, shift, meta)
}

#[cfg(windows)]
unsafe fn is_ptt_member_physically_down(vk: u32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    let configured_key_down = GetAsyncKeyState(vk as i32) < 0;
    let mapped_side_button_down = match vk {
        0xA6 => GetAsyncKeyState(0x05) < 0,
        0xA7 => GetAsyncKeyState(0x06) < 0,
        _ => false,
    };
    configured_key_down || mapped_side_button_down
}

pub fn ptt_physical_key_states(codes: &[String]) -> Vec<bool> {
    #[cfg(windows)]
    {
        return codes
            .iter()
            .map(|code| {
                vk_for_ptt_code(code)
                    .is_some_and(|vk| unsafe { is_ptt_member_physically_down(vk) })
            })
            .collect();
    }

    #[cfg(not(windows))]
    {
        vec![false; codes.len()]
    }
}

#[cfg(windows)]
unsafe fn reconcile_stale_ptt_members_before_down(
    state: &HookSharedState,
    current_index: usize,
) {
    let pressed = state.ptt_pressed_mask.load(Ordering::SeqCst);
    for (index, &member_vk) in state.ptt_vk_codes.iter().enumerate() {
        if index == current_index {
            continue;
        }
        let bit = 1_u64 << index;
        if pressed & bit != 0 && !is_ptt_member_physically_down(member_vk) {
            let _ = release_ptt_member(&state.ptt_pressed_mask, index);
            state
                .ptt_consumed_down_mask
                .fetch_and(!bit, Ordering::SeqCst);
        }
    }
}

#[cfg(windows)]
fn queue_ptt_release(
    sender: &std::sync::mpsc::Sender<HookAction>,
    active_generation: &AtomicU64,
    expected_generation: Option<u64>,
    vk: u32,
    reason: &'static str,
) -> bool {
    let Some(gen) = claim_ptt_release(active_generation, expected_generation) else {
        return false;
    };

    if sender.send(HookAction::PttUp { vk, gen, reason }).is_ok() {
        let _ = complete_ptt_release(active_generation, gen);
        true
    } else {
        let _ = complete_ptt_release(active_generation, gen);
        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
        false
    }
}

///
#[cfg(windows)]
fn spawn_ptt_member_watchdog(
    state: Arc<HookSharedState>,
    action_tx: std::sync::mpsc::Sender<HookAction>,
) -> Option<thread::JoinHandle<()>> {
    const POLL_MS: u64 = 100;
    const REPEAT_SILENCE_MS: i64 = 1_500;
    const RELEASED_SAMPLES_REQUIRED: u8 = 3;

    match thread::Builder::new()
        .name("ptt-member-watchdog".to_string())
        .spawn(move || {
            let mut released_samples = vec![0_u8; state.ptt_vk_codes.len()];
            while state.ptt_hook_alive.load(Ordering::SeqCst) {
                thread::sleep(std::time::Duration::from_millis(POLL_MS));
                if !state.ptt_hook_alive.load(Ordering::SeqCst) {
                    break;
                }

                for (index, &member_vk) in state.ptt_vk_codes.iter().enumerate() {
                    let bit = 1_u64 << index;
                    if state.ptt_pressed_mask.load(Ordering::SeqCst) & bit == 0 {
                        released_samples[index] = 0;
                        continue;
                    }

                    if is_mouse_vk(member_vk) {
                        released_samples[index] = 0;
                        continue;
                    }

                    let repeat_silence_ms = now_ms()
                        .saturating_sub(state.ptt_last_down_ms[index].load(Ordering::SeqCst));
                    let physically_down = unsafe { is_ptt_member_physically_down(member_vk) };
                    if repeat_silence_ms >= REPEAT_SILENCE_MS && !physically_down {
                        released_samples[index] = released_samples[index].saturating_add(1);
                    } else {
                        released_samples[index] = 0;
                    }

                    if released_samples[index] < RELEASED_SAMPLES_REQUIRED {
                        continue;
                    }

                    released_samples[index] = 0;
                    if !release_ptt_member(&state.ptt_pressed_mask, index) {
                        continue;
                    }
                    state
                        .ptt_consumed_down_mask
                        .fetch_and(!bit, Ordering::SeqCst);
                    let active_before = state.ptt_active_generation.load(Ordering::SeqCst);
                    let queued_release = queue_ptt_release(
                        &action_tx,
                        &state.ptt_active_generation,
                        None,
                        member_vk,
                        "member_watchdog_release",
                    );
                    crate::commands::system::write_log_line(&format!(
                        "[RUST] [ptt] member watchdog cleared vk={} setting={} member={} repeat_silence_ms={} active_before={} queued_release={}",
                        member_vk,
                        state.ptt_setting,
                        index,
                        repeat_silence_ms,
                        active_before,
                        queued_release,
                    ));
                }
            }
        }) {
        Ok(handle) => Some(handle),
        Err(error) => {
            crate::commands::system::write_log_line(&format!(
                "[RUST] [ptt] failed to start member watchdog error={}",
                error,
            ));
            None
        }
    }
}

fn emit_ptt_release(state: &HookSharedState, vk: u32, gen: u64, reason: &'static str) {
    crate::commands::system::write_log_line(&format!(
        "[RUST] [ptt] release vk={} setting={} gen={} reason={}",
        vk, state.ptt_setting, gen, reason,
    ));
    let (alt_key, ctrl_key, shift_key, meta_key) = ptt_modifier_flags(&state.ptt_setting);
    let event = PTTEvent {
        source: "rust_hook".to_string(),
        reason: reason.to_string(),
        vk,
        ptt_setting: state.ptt_setting.clone(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        alt_key,
        ctrl_key,
        shift_key,
        meta_key,
    };
    let _ = state.app_handle.emit("ptt-up", &event);
}

#[cfg(windows)]
fn spawn_ptt_release_watchdog(
    state: Arc<HookSharedState>,
    action_tx: std::sync::mpsc::Sender<HookAction>,
    vk: u32,
    gen: u64,
) {
    const POLL_MS: u64 = 100;
    const REPEAT_SILENCE_MS: i64 = 1_500;
    const RELEASED_SAMPLES_REQUIRED: u8 = 3;
    const WARNING_AFTER_SECS: u64 = 4 * 60;
    const HARD_RELEASE_AFTER_SECS: u64 = 5 * 60;

    let fallback_state = state.clone();
    let result = thread::Builder::new()
        .name("ptt-release-watchdog".to_string())
        .spawn(move || {
            let started = std::time::Instant::now();
            let mut released_samples = vec![0_u8; state.ptt_vk_codes.len()];
            let mut warning_sent = false;

            loop {
                thread::sleep(std::time::Duration::from_millis(POLL_MS));

                if state.ptt_active_generation.load(Ordering::SeqCst) != gen {
                    return;
                }

                let mut recovered_member: Option<(usize, u32, i64)> = None;
                for (index, &member_vk) in state.ptt_vk_codes.iter().enumerate() {
                    let bit = 1_u64 << index;
                    if state.ptt_pressed_mask.load(Ordering::SeqCst) & bit == 0 {
                        released_samples[index] = 0;
                        continue;
                    }

                    if is_mouse_vk(member_vk) {
                        released_samples[index] = 0;
                        continue;
                    }

                    let repeat_silence_ms = now_ms()
                        .saturating_sub(state.ptt_last_down_ms[index].load(Ordering::SeqCst));
                    let physically_down = unsafe { is_ptt_member_physically_down(member_vk) };

                    if repeat_silence_ms >= REPEAT_SILENCE_MS && !physically_down {
                        released_samples[index] = released_samples[index].saturating_add(1);
                        if released_samples[index] >= RELEASED_SAMPLES_REQUIRED
                            && recovered_member.is_none()
                        {
                            recovered_member = Some((index, member_vk, repeat_silence_ms));
                        }
                    } else {
                        released_samples[index] = 0;
                    }
                }

                if let Some((index, member_vk, repeat_silence_ms)) = recovered_member {
                    let mut cleared_mask = 0_u64;
                    for (other_index, &other_vk) in state.ptt_vk_codes.iter().enumerate() {
                        let bit = 1_u64 << other_index;
                        if is_mouse_vk(other_vk) {
                            continue;
                        }
                        if state.ptt_pressed_mask.load(Ordering::SeqCst) & bit != 0
                            && !unsafe { is_ptt_member_physically_down(other_vk) }
                        {
                            let _ = release_ptt_member(&state.ptt_pressed_mask, other_index);
                            state
                                .ptt_consumed_down_mask
                                .fetch_and(!bit, Ordering::SeqCst);
                            cleared_mask |= bit;
                        }
                    }

                    let queued = queue_ptt_release(
                        &action_tx,
                        &state.ptt_active_generation,
                        Some(gen),
                        member_vk,
                        "missing_keyup_release",
                    );
                    if queued {
                        crate::commands::system::write_log_line(&format!(
                            "[RUST] [ptt] recovered missing keyup vk={} setting={} gen={} member={} repeat_silence_ms={} cleared_mask=0x{:X}",
                            member_vk,
                            state.ptt_setting,
                            gen,
                            index,
                            repeat_silence_ms,
                            cleared_mask,
                        ));
                    }
                    return;
                }

                let elapsed = started.elapsed();
                if !warning_sent && elapsed.as_secs() >= WARNING_AFTER_SECS {
                    warning_sent = true;
                    crate::commands::system::write_log_line(&format!(
                        "[RUST] [ptt] 4min timeout warning gen={}",
                        gen,
                    ));
                    let (alt_key, ctrl_key, shift_key, meta_key) =
                        ptt_modifier_flags(&state.ptt_setting);
                    let warn_event = PTTEvent {
                        source: "rust_hook".to_string(),
                        reason: "timeout_warning".to_string(),
                        vk,
                        ptt_setting: state.ptt_setting.clone(),
                        timestamp: chrono::Utc::now().timestamp_millis(),
                        alt_key,
                        ctrl_key,
                        shift_key,
                        meta_key,
                    };
                    let _ = state.app_handle.emit("ptt-timeout-warning", &warn_event);
                }

                if elapsed.as_secs() >= HARD_RELEASE_AFTER_SECS {
                    clear_ptt_members(&state);
                    if queue_ptt_release(
                        &action_tx,
                        &state.ptt_active_generation,
                        Some(gen),
                        vk,
                        "hard_timeout_release",
                    ) {
                        crate::commands::system::write_log_line(&format!(
                            "[RUST] [ptt] hard_timeout_release gen={}",
                            gen,
                        ));
                        return;
                    }
                }
            }
        });

    if let Err(error) = result {
        crate::commands::system::write_log_line(&format!(
            "[RUST] [ptt] failed to start release watchdog gen={} error={}",
            gen, error,
        ));
        clear_ptt_members(&fallback_state);
        if let Some(claimed_gen) =
            claim_ptt_release(&fallback_state.ptt_active_generation, Some(gen))
        {
            emit_ptt_release(&fallback_state, vk, claimed_gen, "watchdog_start_failed");
            let _ = complete_ptt_release(&fallback_state.ptt_active_generation, claimed_gen);
        }
    }
}

#[cfg(windows)]
struct CallbackTimer(std::time::Instant);

#[cfg(windows)]
impl Drop for CallbackTimer {
    fn drop(&mut self) {
        let elapsed_us = self.0.elapsed().as_micros() as u64;
        let prev = MAX_CALLBACK_DURATION_US.load(Ordering::Relaxed);
        if elapsed_us > prev {
            MAX_CALLBACK_DURATION_US.store(elapsed_us, Ordering::Relaxed);
        }
    }
}

struct DispatcherAliveGuard;

impl DispatcherAliveGuard {
    fn new() -> Self {
        DISPATCHER_ALIVE.store(true, Ordering::SeqCst);
        Self
    }
}

impl Drop for DispatcherAliveGuard {
    fn drop(&mut self) {
        DISPATCHER_ALIVE.store(false, Ordering::SeqCst);
    }
}

pub fn write_health_snapshot(reason: &str) {
    let last_cb = LAST_CALLBACK_MS.load(Ordering::SeqCst);
    let last_cb_age_ms = if last_cb == 0 { -1 } else { now_ms() - last_cb };
    let dispatcher_alive = DISPATCHER_ALIVE.load(Ordering::SeqCst);
    let hook_running = HOOK_RUNNING.load(Ordering::SeqCst);
    let fail_count = TRY_SEND_FAIL_COUNT.load(Ordering::SeqCst);
    let max_dur_us = MAX_CALLBACK_DURATION_US.load(Ordering::SeqCst);
    crate::commands::system::write_log_line(&format!(
        "[ptt-watchdog] reason={} hook_running={} dispatcher_alive={} last_callback_age_ms={} \
         try_send_fail_count={} max_callback_duration_us={}",
        reason, hook_running, dispatcher_alive, last_cb_age_ms, fail_count, max_dur_us,
    ));
}

///
pub fn spawn_health_watchdog() {
    let _ = thread::Builder::new()
        .name("ptt-watchdog".to_string())
        .spawn(|| {
            loop {
                thread::sleep(std::time::Duration::from_secs(60));

                let hook_running = HOOK_RUNNING.load(Ordering::SeqCst);
                let dispatcher_alive = DISPATCHER_ALIVE.load(Ordering::SeqCst);
                let fail_count = TRY_SEND_FAIL_COUNT.load(Ordering::SeqCst);

                let state_changed = hook_running != WD_LAST_HOOK_RUNNING.load(Ordering::SeqCst)
                    || dispatcher_alive != WD_LAST_DISPATCHER_ALIVE.load(Ordering::SeqCst)
                    || fail_count != WD_LAST_FAIL_COUNT.load(Ordering::SeqCst);

                let last_log = WD_LAST_LOG_MS.load(Ordering::SeqCst);
                let heartbeat_due = last_log == 0 || (now_ms() - last_log) >= WD_HEARTBEAT_MS;

                if state_changed || heartbeat_due {
                    write_health_snapshot(if state_changed { "change" } else { "heartbeat" });
                    WD_LAST_HOOK_RUNNING.store(hook_running, Ordering::SeqCst);
                    WD_LAST_DISPATCHER_ALIVE.store(dispatcher_alive, Ordering::SeqCst);
                    WD_LAST_FAIL_COUNT.store(fail_count, Ordering::SeqCst);
                    WD_LAST_LOG_MS.store(now_ms(), Ordering::SeqCst);
                }
            }
        });
}

// Thread-local storage for the hook callback
thread_local! {
    static HOOK_STATE: std::cell::RefCell<Option<Arc<HookSharedState>>> = std::cell::RefCell::new(None);
    /// Non-blocking channel sender for offloading work from the hook callback.
    static HOOK_ACTION_TX: std::cell::RefCell<Option<std::sync::mpsc::Sender<HookAction>>> = std::cell::RefCell::new(None);
}

pub struct KeyboardHookManager {
    hook_thread_id: Mutex<Option<u32>>,
    hook_thread: Mutex<Option<thread::JoinHandle<()>>>,
    shared_state: Mutex<Option<Arc<HookSharedState>>>,
    running: AtomicBool,
}

impl KeyboardHookManager {
    pub fn new() -> Self {
        Self {
            hook_thread_id: Mutex::new(None),
            hook_thread: Mutex::new(None),
            shared_state: Mutex::new(None),
            running: AtomicBool::new(false),
        }
    }

    /// Start the keyboard hook with PTT, hands-free, and AI-cleanup single-key settings.
    pub fn start(&self, app: &AppHandle, ptt_setting: &str, hf_setting: &str, ai_toggle_setting: &str) {
        crate::commands::system::write_log_line(&format!(
            "[ptt-lifecycle] start() called ptt_setting={} hf_setting={} ai_toggle_setting={}",
            ptt_setting, hf_setting, ai_toggle_setting,
        ));
        let has_hook_thread = self.hook_thread.lock().unwrap().is_some();
        if self.running.load(Ordering::SeqCst) || has_hook_thread {
            self.stop();
        }

        let ptt_config = ptt_key_config(ptt_setting);
        let hf_vk_codes = if is_single_key_setting(hf_setting) {
            vk_codes_for_setting(hf_setting)
        } else {
            vec![] // combo key — handled by global_shortcut, not hook
        };
        let ai_toggle_vk_codes = if is_single_key_setting(ai_toggle_setting) {
            vk_codes_for_setting(ai_toggle_setting)
        } else {
            vec![] // combo key — handled by global_shortcut, not hook
        };
        let ptt_full_mask = if ptt_config.vk_codes.is_empty() {
            0
        } else {
            (1_u64 << ptt_config.vk_codes.len()) - 1
        };
        let ptt_last_down_ms = (0..ptt_config.vk_codes.len())
            .map(|_| AtomicI64::new(0))
            .collect();

        let state = Arc::new(HookSharedState {
            ptt_vk_codes: ptt_config.vk_codes,
            ptt_setting: ptt_config.setting,
            ptt_pressed_mask: AtomicU64::new(0),
            ptt_full_mask,
            ptt_modifier_mask: ptt_config.modifier_mask,
            ptt_consumed_down_mask: AtomicU64::new(0),
            ptt_active_generation: AtomicU64::new(0),
            ptt_generation: AtomicU64::new(0),
            ptt_last_down_ms,
            ptt_hook_alive: AtomicBool::new(true),
            hands_free_active: AtomicBool::new(false),
            hf_key_down: AtomicBool::new(false),
            hf_vk_codes,
            hf_setting: hf_setting.to_string(),
            ai_toggle_key_down: AtomicBool::new(false),
            ai_toggle_vk_codes,
            ai_toggle_setting: ai_toggle_setting.to_string(),
            app_handle: app.clone(),
        });

        *self.shared_state.lock().unwrap() = Some(state.clone());
        self.running.store(true, Ordering::SeqCst);

        let state_for_thread = state.clone();
        let (tx, rx) = std::sync::mpsc::channel::<u32>();

        let hook_thread = thread::spawn(move || {
            Self::hook_thread(state_for_thread, tx);
        });
        *self.hook_thread.lock().unwrap() = Some(hook_thread);

        // Wait for the thread to report its ID
        if let Ok(thread_id) = rx.recv_timeout(std::time::Duration::from_secs(5)) {
            *self.hook_thread_id.lock().unwrap() = Some(thread_id);
            HOOK_RUNNING.store(true, Ordering::SeqCst);
            log::info!("Keyboard hook started, thread_id={}", thread_id);
            crate::commands::system::write_log_line(&format!(
                "[ptt-lifecycle] hook started OK thread_id={}", thread_id,
            ));
        } else {
            log::error!("Keyboard hook thread failed to start");
            crate::commands::system::write_log_line(
                "[ptt-lifecycle] hook FAILED to start (rx.recv_timeout expired after 5s)"
            );
            self.running.store(false, Ordering::SeqCst);
            HOOK_RUNNING.store(false, Ordering::SeqCst);
        }
    }

    /// Stop the keyboard hook
    pub fn stop(&self) {
        crate::commands::system::write_log_line("[ptt-lifecycle] stop() called");
        self.running.store(false, Ordering::SeqCst);
        HOOK_RUNNING.store(false, Ordering::SeqCst);

        #[cfg(windows)]
        if let Some(state) = self.shared_state.lock().unwrap().as_ref() {
            let had_active = state.ptt_active_generation.load(Ordering::SeqCst) != 0;
            clear_ptt_members(state);

            if had_active {
                if !is_mouse_button_setting(&state.ptt_setting) {
                    for &vk in &state.ptt_vk_codes {
                        unsafe {
                            use windows::Win32::UI::Input::KeyboardAndMouse::*;
                            let mut input = INPUT {
                                r#type: INPUT_KEYBOARD,
                                ..std::mem::zeroed()
                            };
                            input.Anonymous.ki = KEYBDINPUT {
                                wVk: VIRTUAL_KEY(vk as u16),
                                dwFlags: KEYEVENTF_KEYUP,
                                ..std::mem::zeroed()
                            };
                            SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
                        }
                    }
                    log::info!("[ptt] sent synthetic keyup on stop to clear keyboard state");
                }
            }
        }

        if let Some(thread_id) = self.hook_thread_id.lock().unwrap().take() {
            #[cfg(windows)]
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }

        if let Some(hook_thread) = self.hook_thread.lock().unwrap().take() {
            if hook_thread.join().is_err() {
                crate::commands::system::write_log_line(
                    "[ptt-lifecycle] hook thread panicked while stopping",
                );
            }
        }

        #[cfg(windows)]
        if let Some(state) = self.shared_state.lock().unwrap().as_ref() {
            clear_ptt_members(state);
            let _ = clear_ptt_press(&state.ptt_active_generation);
        }
        *self.shared_state.lock().unwrap() = None;
    }

    /// Reconfigure with new PTT, hands-free, and AI-cleanup settings.
    pub fn reconfigure(&self, app: &AppHandle, ptt_setting: &str, hf_setting: &str, ai_toggle_setting: &str) {
        let count = RECONFIGURE_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
        crate::commands::system::write_log_line(&format!(
            "[ptt-lifecycle] reconfigure() #{} ptt_setting={} hf_setting={} ai_toggle_setting={} — waiting for old hook shutdown",
            count, ptt_setting, hf_setting, ai_toggle_setting,
        ));
        self.stop();
        self.start(app, ptt_setting, hf_setting, ai_toggle_setting);
    }

    /// Set hands-free mode active (suppresses PTT up events temporarily)
    #[allow(dead_code)]
    pub fn set_hands_free(&self, active: bool) {
        if let Some(state) = self.shared_state.lock().unwrap().as_ref() {
            state.hands_free_active.store(active, Ordering::SeqCst);
            if active {
                clear_ptt_members(state);
                let _ = clear_ptt_press(&state.ptt_active_generation);
            }
        }
    }

    #[cfg(windows)]
    fn hook_thread(state: Arc<HookSharedState>, tx: std::sync::mpsc::Sender<u32>) {
        use windows::Win32::System::Threading::GetCurrentThreadId;

        log::info!(
            "keyboard hook thread starting, ptt_setting={} vk_codes={:?}",
            state.ptt_setting, state.ptt_vk_codes
        );

        let (action_tx, action_rx) = std::sync::mpsc::channel::<HookAction>();
        let watchdog_action_tx = action_tx.clone();
        let member_watchdog = spawn_ptt_member_watchdog(state.clone(), action_tx.clone());

        // Spawn dispatcher thread — handles logging and emit (potentially blocking ops)
        let dispatch_state = state.clone();
        let dispatcher_thread = thread::Builder::new()
            .name("ptt-dispatcher".to_string())
            .spawn(move || {
            let _alive_guard = DispatcherAliveGuard::new();
            crate::commands::system::write_log_line("[ptt-dispatcher] thread started");
            while let Ok(action) = action_rx.recv() {
                match action {
                    HookAction::Shutdown => break,
                    HookAction::Diag { vk, msg_name, flags, scan_code } => {
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [hook-diag] vk={} msg={} flags=0x{:X} scanCode=0x{:X}", vk, msg_name, flags, scan_code)
                        );
                    }
                    HookAction::PttDown { vk, gen } => {
                        let setting = &dispatch_state.ptt_setting;
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [ptt] keydown vk={} setting={} gen={}", vk, setting, gen)
                        );
                        let (alt_key, ctrl_key, shift_key, meta_key) =
                            ptt_modifier_flags(setting);
                        let event = PTTEvent {
                            source: "rust_hook".to_string(),
                            reason: "keydown".to_string(),
                            vk,
                            ptt_setting: setting.clone(),
                            timestamp: chrono::Utc::now().timestamp_millis(),
                            alt_key,
                            ctrl_key,
                            shift_key,
                            meta_key,
                        };
                        let _ = dispatch_state.app_handle.emit("ptt-down", &event);
                        spawn_ptt_release_watchdog(
                            dispatch_state.clone(),
                            watchdog_action_tx.clone(),
                            vk,
                            gen,
                        );
                    }
                    HookAction::PttUp { vk, gen, reason } => {
                        emit_ptt_release(&dispatch_state, vk, gen, reason);
                    }
                    HookAction::HfToggle { vk } => {
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [hf] toggle vk={} setting={}", vk, dispatch_state.hf_setting)
                        );
                        let _ = dispatch_state.app_handle.emit("toggle-hands-free", serde_json::json!({
                            "source": "rust_hook",
                            "vk": vk,
                        }));
                    }
                    HookAction::AiToggle { vk } => {
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [ai-toggle] vk={} setting={}", vk, dispatch_state.ai_toggle_setting)
                        );
                        let _ = dispatch_state.app_handle.emit("toggle-ai-cleanup", serde_json::json!({
                            "source": "rust_hook",
                            "vk": vk,
                        }));
                    }
                    HookAction::Escape { mode, token } => {
                        let mode_name = escape_action_mode_name(mode);
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [escape] action mode={mode_name} token={token}")
                        );
                        let _ = dispatch_state.app_handle.emit("escape-action", serde_json::json!({
                            "mode": mode_name,
                            "token": token,
                        }));
                    }
                    HookAction::CardHotkey { action, token } => {
                        let action_name = card_hotkey_action_name(action);
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [card-hotkey] action={action_name} token={token}")
                        );
                        let _ = dispatch_state.app_handle.emit("card-hotkey", serde_json::json!({
                            "action": action_name,
                            "token": token,
                        }));
                    }
                    HookAction::MouseCaptured { vk } => {
                        let setting = match vk {
                            0x04 => "MButton",
                            0x05 => "XButton1",
                            0x06 => "XButton2",
                            0xA6 => "BrowserBack",
                            0xA7 => "BrowserForward",
                            _ => "",
                        };
                        crate::commands::system::write_log_line(
                            &format!("[RUST] [shortcut-capture] mouse side button vk={} setting={}", vk, setting)
                        );
                        let _ = dispatch_state.app_handle.emit("mouse-shortcut-captured", serde_json::json!({
                            "setting": setting,
                            "vk": vk,
                        }));
                    }
                }
            }
            log::info!("[ptt] dispatcher thread exited");
            crate::commands::system::write_log_line(
                "[ptt-dispatcher] thread exited (shutdown or all senders dropped)"
            );
            // _alive_guard drops here, flips DISPATCHER_ALIVE back to false.
        }).expect("failed to spawn ptt-dispatcher thread");

        // Set thread-local state for the callback
        HOOK_STATE.with(|s| {
            *s.borrow_mut() = Some(state.clone());
        });
        HOOK_ACTION_TX.with(|s| {
            *s.borrow_mut() = Some(action_tx);
        });

        unsafe {
            let install_hook = || -> Option<windows::Win32::UI::WindowsAndMessaging::HHOOK> {
                match SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(low_level_keyboard_proc),
                    None,
                    0,
                ) {
                    Ok(h) => {
                        log::info!("SetWindowsHookExW succeeded: {:?}", h.0);
                        Some(h)
                    }
                    Err(e) => {
                        log::error!("SetWindowsHookExW failed: {}", e);
                        None
                    }
                }
            };

            let hook = match install_hook() {
                Some(h) => h,
                None => {
                    state.ptt_hook_alive.store(false, Ordering::SeqCst);
                    if let Some(handle) = member_watchdog {
                        let _ = handle.join();
                    }
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow_mut().take() {
                            let _ = sender.send(HookAction::Shutdown);
                        }
                    });
                    HOOK_STATE.with(|s| {
                        *s.borrow_mut() = None;
                    });
                    let _ = dispatcher_thread.join();
                    return;
                }
            };

            let mouse_hook: Option<windows::Win32::UI::WindowsAndMessaging::HHOOK> =
                match SetWindowsHookExW(WH_MOUSE_LL, Some(low_level_mouse_proc), None, 0) {
                    Ok(h) => {
                        log::info!("SetWindowsHookExW(WH_MOUSE_LL) succeeded: {:?}", h.0);
                        crate::commands::system::write_log_line(
                            "[ptt-lifecycle] mouse hook installed (side-button support active)",
                        );
                        Some(h)
                    }
                    Err(e) => {
                        log::error!("SetWindowsHookExW(WH_MOUSE_LL) failed: {}", e);
                        crate::commands::system::write_log_line(&format!(
                            "[ptt-lifecycle] mouse hook FAILED to install: {}", e,
                        ));
                        None
                    }
                };

            let thread_id = GetCurrentThreadId();
            let _ = tx.send(thread_id);
            log::info!("keyboard hook message loop starting on thread {}", thread_id);

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            log::info!("keyboard hook message loop exited");
            let _ = UnhookWindowsHookEx(hook);
            if let Some(mh) = mouse_hook {
                let _ = UnhookWindowsHookEx(mh);
            }
        }

        state.ptt_hook_alive.store(false, Ordering::SeqCst);
        if let Some(handle) = member_watchdog {
            if handle.join().is_err() {
                crate::commands::system::write_log_line(
                    "[ptt-lifecycle] member watchdog panicked while stopping",
                );
            }
        }
        HOOK_ACTION_TX.with(|s| {
            if let Some(sender) = s.borrow_mut().take() {
                clear_ptt_members(&state);
                let vk = state.ptt_vk_codes.first().copied().unwrap_or(0);
                let _ = queue_ptt_release(
                    &sender,
                    &state.ptt_active_generation,
                    None,
                    vk,
                    "manager_stop",
                );
                let _ = sender.send(HookAction::Shutdown);
            }
        });
        HOOK_STATE.with(|s| {
            *s.borrow_mut() = None;
        });
        if dispatcher_thread.join().is_err() {
            crate::commands::system::write_log_line(
                "[ptt-lifecycle] dispatcher thread panicked while stopping",
            );
        }
    }

    #[cfg(not(windows))]
    fn hook_thread(_state: Arc<HookSharedState>, tx: std::sync::mpsc::Sender<u32>) {
        let _ = tx.send(0);
        // No-op on non-Windows
    }
}

///
#[cfg(windows)]
unsafe extern "system" fn low_level_mouse_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    let msg = w_param.0 as u32;

    if n_code < 0
        || (msg != WM_XBUTTONDOWN
            && msg != WM_XBUTTONUP
            && msg != WM_MBUTTONDOWN
            && msg != WM_MBUTTONUP)
    {
        return CallNextHookEx(None, n_code, w_param, l_param);
    }

    let ms = &*(l_param.0 as *const MSLLHOOKSTRUCT);

    const LLMHF_INJECTED: u32 = 0x00000001;
    if (ms.flags & LLMHF_INJECTED) != 0 {
        return CallNextHookEx(None, n_code, w_param, l_param);
    }

    let is_middle = msg == WM_MBUTTONDOWN || msg == WM_MBUTTONUP;
    let vk: u32 = if is_middle {
        0x04 // VK_MBUTTON
    } else {
        match (ms.mouseData >> 16) & 0xFFFF {
            1 => 0x05, // VK_XBUTTON1
            2 => 0x06, // VK_XBUTTON2
            _ => return CallNextHookEx(None, n_code, w_param, l_param),
        }
    };

    let is_down = msg == WM_XBUTTONDOWN || msg == WM_MBUTTONDOWN;
    let is_up = msg == WM_XBUTTONUP || msg == WM_MBUTTONUP;

    if SHORTCUT_CAPTURE.load(Ordering::SeqCst) {
        if is_down {
            SHORTCUT_CAPTURE.store(false, Ordering::SeqCst);
            CONSUME_XUP_VK.store(vk, Ordering::SeqCst);
            HOOK_ACTION_TX.with(|tx| {
                if let Some(sender) = tx.borrow().as_ref() {
                    if sender.send(HookAction::MouseCaptured { vk }).is_err() {
                        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                    }
                }
            });
        }
        return LRESULT(1);
    }
    if is_up && CONSUME_XUP_VK.load(Ordering::SeqCst) == vk {
        CONSUME_XUP_VK.store(0, Ordering::SeqCst);
        return LRESULT(1);
    }

    let mut consumed = false;

    HOOK_STATE.with(|s| {
        if let Some(state) = s.borrow().as_ref() {
            let ptt_member = ptt_member_index(&state.ptt_vk_codes, vk);
            let is_ptt_key = ptt_member.is_some();
            let is_hf_key = !state.hf_vk_codes.is_empty()
                && state.hf_vk_codes.contains(&vk)
                && !is_ptt_key;
            let is_ai_toggle_key = !state.ai_toggle_vk_codes.is_empty()
                && state.ai_toggle_vk_codes.contains(&vk)
                && !is_ptt_key
                && !is_hf_key;

            if let Some(member_index) = ptt_member {
                consumed = true;

                if is_down {
                    state.ptt_last_down_ms[member_index].store(now_ms(), Ordering::SeqCst);
                    let became_complete = press_ptt_member(
                        &state.ptt_pressed_mask,
                        member_index,
                        state.ptt_full_mask,
                    );
                    if became_complete && !state.hands_free_active.load(Ordering::SeqCst) {
                        if let Some(gen) = begin_ptt_press(
                            &state.ptt_active_generation,
                            &state.ptt_generation,
                        ) {
                            HOOK_ACTION_TX.with(|tx| {
                                if let Some(sender) = tx.borrow().as_ref() {
                                    if sender.send(HookAction::PttDown { vk, gen }).is_err() {
                                        let _ = release_ptt_member(
                                            &state.ptt_pressed_mask,
                                            member_index,
                                        );
                                        cancel_ptt_press_start(&state.ptt_active_generation, gen);
                                        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            });
                        }
                    }
                }

                if is_up && release_ptt_member(&state.ptt_pressed_mask, member_index) {
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow().as_ref() {
                            let _ = queue_ptt_release(
                                sender,
                                &state.ptt_active_generation,
                                None,
                                vk,
                                "keyup",
                            );
                        }
                    });
                }
            }

            if is_hf_key {
                if is_down {
                    consumed = true;
                    if begin_hf_press(&state.hf_key_down) {
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                if sender.send(HookAction::HfToggle { vk }).is_err() {
                                    TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        });
                    }
                }
                if is_up && end_hf_press(&state.hf_key_down) {
                    consumed = true;
                }
            }

            if is_ai_toggle_key {
                if is_down {
                    consumed = true;
                    if begin_hf_press(&state.ai_toggle_key_down) {
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                if sender.send(HookAction::AiToggle { vk }).is_err() {
                                    TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        });
                    }
                }
                if is_up && end_hf_press(&state.ai_toggle_key_down) {
                    consumed = true;
                }
            }
        }
    });

    if consumed {
        return LRESULT(1);
    }
    CallNextHookEx(None, n_code, w_param, l_param)
}

#[cfg(windows)]
unsafe extern "system" fn low_level_keyboard_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    let _timer = CallbackTimer(std::time::Instant::now());
    LAST_CALLBACK_MS.store(now_ms(), Ordering::Relaxed);

    if n_code >= 0 {
        let kb = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
        let vk = kb.vkCode;
        let msg = w_param.0 as u32;

        const LLKHF_INJECTED: u32 = 0x10;
        const LLKHF_LOWER_IL_INJECTED: u32 = 0x02;

        let kb_flags = kb.flags.0;
        let kb_scan_code = kb.scanCode;

        let is_kdown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let is_kup = msg == WM_KEYUP || msg == WM_SYSKEYUP;

        if SHORTCUT_CAPTURE.load(Ordering::SeqCst) {
            HOOK_STATE.with(|s| {
                if let Some(state) = s.borrow().as_ref() {
                    clear_ptt_members(state);
                    if let Some(&ptt_vk) = state.ptt_vk_codes.first() {
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                let _ = queue_ptt_release(
                                    sender,
                                    &state.ptt_active_generation,
                                    None,
                                    ptt_vk,
                                    "shortcut_capture",
                                );
                            }
                        });
                    }
                    state.hf_key_down.store(false, Ordering::SeqCst);
                }
            });

            if vk == 0xA6 || vk == 0xA7 {
                if is_kdown {
                    SHORTCUT_CAPTURE.store(false, Ordering::SeqCst);
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow().as_ref() {
                            let _ = sender.send(HookAction::MouseCaptured { vk });
                        }
                    });
                }
                return LRESULT(1);
            }

            return CallNextHookEx(None, n_code, w_param, l_param);
        }

        let is_synthetic = ((kb.flags.0 & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) != 0
            || kb.scanCode == 0)
            && !is_injection_exempt_vk(vk);
        if is_synthetic {
            let mut consume_paired_up = false;
            if is_kup {
                HOOK_STATE.with(|s| {
                    if let Some(state) = s.borrow().as_ref() {
                        if state.hf_vk_codes.contains(&vk) {
                            consume_paired_up = end_hf_press(&state.hf_key_down);
                        }
                        if let Some(member_index) = ptt_member_index(&state.ptt_vk_codes, vk) {
                            let member_bit = 1_u64 << member_index;
                            consume_paired_up = state
                                .ptt_consumed_down_mask
                                .fetch_and(!member_bit, Ordering::SeqCst)
                                & member_bit
                                != 0;
                            let physically_down = unsafe { is_ptt_member_physically_down(vk) };
                            if !physically_down
                                && release_ptt_member(&state.ptt_pressed_mask, member_index)
                            {
                                HOOK_ACTION_TX.with(|tx| {
                                    if let Some(sender) = tx.borrow().as_ref() {
                                        let _ = queue_ptt_release(
                                            sender,
                                            &state.ptt_active_generation,
                                            None,
                                            vk,
                                            "synthetic_keyup",
                                        );
                                    }
                                });
                            }
                        }
                    }
                });
            }
            if consume_paired_up {
                return LRESULT(1);
            }
            return CallNextHookEx(None, n_code, w_param, l_param);
        }

        const VK_ESCAPE: u32 = 0x1B;
        if vk == VK_ESCAPE {
            let is_kup = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if is_kdown {
                if ESCAPE_KEY_DOWN.load(Ordering::SeqCst) {
                    return LRESULT(1);
                }
                let (mode, token) = active_escape_action();
                if mode != ESCAPE_MODE_OFF {
                    let first_down = !ESCAPE_KEY_DOWN.swap(true, Ordering::SeqCst);
                    if first_down {
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                if sender.send(HookAction::Escape { mode, token }).is_err() {
                                    TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        });
                    }
                    return LRESULT(1);
                }
            }
            if is_kup && ESCAPE_KEY_DOWN.swap(false, Ordering::SeqCst) {
                return LRESULT(1);
            }
        }

        const VK_C: u32 = 0x43;
        if vk == VK_C {
            if is_kdown {
                if CARD_HOTKEY_C_DOWN.load(Ordering::SeqCst) {
                    return LRESULT(1);
                }
                let (mask, token) = active_card_hotkeys();
                if mask & CARD_HOTKEY_COPY != 0
                    && only_ctrl_is_down(kb_flags)
                    && card_hotkey_foreground_matches()
                {
                    CARD_HOTKEY_C_DOWN.store(true, Ordering::SeqCst);
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow().as_ref() {
                            if sender
                                .send(HookAction::CardHotkey { action: CARD_HOTKEY_COPY, token })
                                .is_err()
                            {
                                TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    });
                    return LRESULT(1);
                }
            }
            if is_kup && CARD_HOTKEY_C_DOWN.swap(false, Ordering::SeqCst) {
                return LRESULT(1);
            }
        }

        // ── CRITICAL: This callback MUST return within ~200ms or Windows
        // will silently remove the hook. NO blocking operations allowed.
        // All logging and emit are offloaded through the non-blocking action channel.

        let mut consumed = false;

        HOOK_STATE.with(|s| {
            if let Some(state) = s.borrow().as_ref() {
                let ptt_member = ptt_member_index(&state.ptt_vk_codes, vk);
                let is_ptt_key = ptt_member.is_some();
                let is_hf_key = !state.hf_vk_codes.is_empty()
                    && state.hf_vk_codes.contains(&vk)
                    && !is_ptt_key; // PTT takes priority if same key
                let is_ai_toggle_key = !state.ai_toggle_vk_codes.is_empty()
                    && state.ai_toggle_vk_codes.contains(&vk)
                    && !is_ptt_key
                    && !is_hf_key; // PTT / hands-free take priority if misconfigured

                let is_alt_key = vk == 0xA4 || vk == 0xA5;

                //
                let modifiers_block_down = single_key_blocked_by_modifiers(vk, kb_flags);

                let should_log_hotkey_down = is_kdown
                    && ((ptt_member.is_some_and(|index| {
                        state.ptt_pressed_mask.load(Ordering::SeqCst) & (1_u64 << index) == 0
                    }) && !state.hands_free_active.load(Ordering::SeqCst))
                        || (is_hf_key && !state.hf_key_down.load(Ordering::SeqCst)));
                if should_log_hotkey_down {
                    let msg_name = if modifiers_block_down {
                        "hotkey-down-with-modifier"
                    } else {
                        "hotkey-down"
                    };
                    HOOK_ACTION_TX.with(|tx| {
                        if let Some(sender) = tx.borrow().as_ref() {
                            if sender.send(HookAction::Diag {
                                vk, msg_name, flags: kb_flags, scan_code: kb_scan_code,
                            }).is_err() {
                                TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    });
                }

                if let Some(member_index) = ptt_member {
                    if is_kdown {
                        reconcile_stale_ptt_members_before_down(state, member_index);
                    }
                    let member_bit = 1_u64 << member_index;
                    let is_combo = state.ptt_vk_codes.len() > 1;
                    let is_pure_modifier_combo = is_combo
                        && state.ptt_modifier_mask == state.ptt_full_mask;
                    let is_main_key = state.ptt_modifier_mask & member_bit == 0;
                    let bare_press_violated = !is_combo && modifiers_block_down;

                    if !is_combo {
                        if (is_kdown && !bare_press_violated) || (is_kup && is_alt_key) {
                            consumed = true;
                        }
                    } else if !is_pure_modifier_combo && is_main_key {
                        if is_kdown {
                            let pressed_before =
                                state.ptt_pressed_mask.load(Ordering::SeqCst);
                            let consume_this_press = should_consume_combo_main_down(
                                pressed_before,
                                state.ptt_consumed_down_mask.load(Ordering::SeqCst),
                                member_bit,
                                state.ptt_modifier_mask,
                            );
                            if consume_this_press {
                                state
                                    .ptt_consumed_down_mask
                                    .fetch_or(member_bit, Ordering::SeqCst);
                                consumed = true;
                            }
                        }
                        if is_kup
                            && state
                                .ptt_consumed_down_mask
                                .fetch_and(!member_bit, Ordering::SeqCst)
                                & member_bit
                                != 0
                        {
                            consumed = true;
                        }
                    }

                    if is_kdown && !bare_press_violated {
                        state.ptt_last_down_ms[member_index].store(now_ms(), Ordering::SeqCst);
                        let became_complete = press_ptt_member(
                            &state.ptt_pressed_mask,
                            member_index,
                            state.ptt_full_mask,
                        );
                        if became_complete && !state.hands_free_active.load(Ordering::SeqCst) {
                            if let Some(gen) = begin_ptt_press(
                                &state.ptt_active_generation,
                                &state.ptt_generation,
                            ) {
                                HOOK_ACTION_TX.with(|tx| {
                                    if let Some(sender) = tx.borrow().as_ref() {
                                        if sender.send(HookAction::PttDown { vk, gen }).is_err() {
                                            let _ = release_ptt_member(
                                                &state.ptt_pressed_mask,
                                                member_index,
                                            );
                                            state
                                                .ptt_consumed_down_mask
                                                .fetch_and(!member_bit, Ordering::SeqCst);
                                            cancel_ptt_press_start(
                                                &state.ptt_active_generation,
                                                gen,
                                            );
                                            TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                        }
                                    }
                                });
                            }
                        }
                    }

                    if is_kup && release_ptt_member(&state.ptt_pressed_mask, member_index) {
                        HOOK_ACTION_TX.with(|tx| {
                            if let Some(sender) = tx.borrow().as_ref() {
                                let _ = queue_ptt_release(
                                    sender,
                                    &state.ptt_active_generation,
                                    None,
                                    vk,
                                    "member_keyup",
                                );
                            }
                        });
                    }
                }

                if is_hf_key {
                    let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                    let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                    if is_down && !modifiers_block_down {
                        consumed = true;
                        if begin_hf_press(&state.hf_key_down) {
                            HOOK_ACTION_TX.with(|tx| {
                                if let Some(sender) = tx.borrow().as_ref() {
                                    if sender.send(HookAction::HfToggle { vk }).is_err() {
                                        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            });
                        }
                    }
                    if is_up {
                        if end_hf_press(&state.hf_key_down) || is_alt_key {
                            consumed = true;
                        }
                    }
                }

                if is_ai_toggle_key {
                    let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                    let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                    if is_down && !modifiers_block_down {
                        consumed = true;
                        if begin_hf_press(&state.ai_toggle_key_down) {
                            HOOK_ACTION_TX.with(|tx| {
                                if let Some(sender) = tx.borrow().as_ref() {
                                    if sender.send(HookAction::AiToggle { vk }).is_err() {
                                        TRY_SEND_FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            });
                        }
                    }
                    if is_up && (end_hf_press(&state.ai_toggle_key_down) || is_alt_key) {
                        consumed = true;
                    }
                }
            }
        });

        if consumed {
            return LRESULT(1);
        }
    }

    CallNextHookEx(None, n_code, w_param, l_param)
}

#[cfg(test)]
mod tests {
    use super::{
        active_card_hotkeys, begin_hf_press, begin_ptt_press, card_hotkey_action_name,
        claim_ptt_release, complete_ptt_release, end_hf_press, escape_action_mode_name,
        is_injection_exempt_vk, is_mouse_button_setting, is_mouse_vk, modifier_kind,
        press_ptt_member, ptt_key_config, release_ptt_member, set_card_hotkeys,
        set_escape_action_mode, should_consume_combo_main_down, single_key_requires_bare_press,
        CARD_HOTKEY_COPY, CARD_HOTKEY_DEADLINE_MS, CARD_HOTKEY_FOREGROUND, DEFAULT_PTT_SETTING,
        DEFAULT_PTT_VK, SINGLE_KEY_TABLE,
    };
    #[cfg(windows)]
    use super::queue_ptt_release;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

        ///
            #[test]
    fn card_hotkeys_are_scoped_to_one_card_and_expire_on_their_own() {
        assert!(set_card_hotkeys(&["retry".to_string()], 1).is_err());

        set_card_hotkeys(&["copy".to_string()], 7).unwrap();
        assert_eq!(active_card_hotkeys(), (CARD_HOTKEY_COPY, 7));

        CARD_HOTKEY_FOREGROUND.store(0x1234, Ordering::SeqCst);
        set_card_hotkeys(&["copy".to_string()], 7).unwrap();
        assert_eq!(
            CARD_HOTKEY_FOREGROUND.load(Ordering::SeqCst),
            0x1234,
            "renewal must keep the foreground window captured when the card appeared",
        );

        CARD_HOTKEY_DEADLINE_MS.store(1, Ordering::SeqCst);
        assert_eq!(active_card_hotkeys(), (0, 0));
        assert_eq!(
            CARD_HOTKEY_FOREGROUND.load(Ordering::SeqCst),
            0,
            "expiry must also drop the captured foreground window",
        );

        set_card_hotkeys(&["copy".to_string()], 8).unwrap();
        set_card_hotkeys(&[], 8).unwrap();
        assert_eq!(active_card_hotkeys(), (0, 0));
    }

            #[test]
    fn hotkey_and_escape_names_match_the_frontend_contract() {
        assert_eq!(card_hotkey_action_name(CARD_HOTKEY_COPY), "copy");

        for mode in [
            "off",
            "cancel_recording",
            "cancel_processing",
            "dismiss_fallback",
            "abandon_late_result",
        ] {
            set_escape_action_mode(mode, 1).unwrap();
            let value = super::ESCAPE_ACTION_MODE.load(Ordering::SeqCst);
            assert_eq!(escape_action_mode_name(value), mode, "mode name drifted: {mode}");
        }
        set_escape_action_mode("off", 0).unwrap();
    }

    #[test]
    fn hands_free_triggers_on_first_down_and_rearms_on_up() {
        let key_down = AtomicBool::new(false);

        assert!(begin_hf_press(&key_down));
        assert!(!begin_hf_press(&key_down), "repeat down must not toggle again");
        assert!(end_hf_press(&key_down));
        assert!(!end_hf_press(&key_down), "orphan up is ignored");
        assert!(begin_hf_press(&key_down), "next physical press is re-armed");
    }

    #[test]
    fn ptt_release_is_idempotent_for_normal_or_synthetic_keyup() {
        let active_generation = AtomicU64::new(0);
        let generation = AtomicU64::new(0);

        let gen = begin_ptt_press(&active_generation, &generation).expect("first down starts a run");
        assert_eq!(gen, 1);
        assert!(begin_ptt_press(&active_generation, &generation).is_none());
        assert_eq!(claim_ptt_release(&active_generation, None), Some(gen));
        assert!(claim_ptt_release(&active_generation, None).is_none());
        assert!(complete_ptt_release(&active_generation, gen));
        assert_eq!(active_generation.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn combo_starts_only_when_all_members_are_down_and_repeat_does_not_restart() {
        let pressed_mask = AtomicU64::new(0);
        let full_mask = 0b11;

        assert!(!press_ptt_member(&pressed_mask, 0, full_mask));
        assert_eq!(pressed_mask.load(Ordering::SeqCst), 0b01);
        assert!(press_ptt_member(&pressed_mask, 1, full_mask));
        assert_eq!(pressed_mask.load(Ordering::SeqCst), full_mask);
        assert!(!press_ptt_member(&pressed_mask, 1, full_mask));
    }

    #[test]
    fn combo_main_key_is_consumed_only_when_modifiers_precede_it() {
        let modifier_mask = 0b01;
        let main_bit = 0b10;

        assert!(!should_consume_combo_main_down(
            0,
            0,
            main_bit,
            modifier_mask,
        ));
        assert!(should_consume_combo_main_down(
            modifier_mask,
            0,
            main_bit,
            modifier_mask,
        ));
        assert!(!should_consume_combo_main_down(
            main_bit | modifier_mask,
            0,
            main_bit,
            modifier_mask,
        ));
        assert!(should_consume_combo_main_down(
            main_bit | modifier_mask,
            main_bit,
            main_bit,
            modifier_mask,
        ));
    }

    #[test]
    fn any_combo_member_up_releases_and_can_complete_again() {
        let pressed_mask = AtomicU64::new(0);
        let full_mask = 0b11;
        assert!(!press_ptt_member(&pressed_mask, 0, full_mask));
        assert!(press_ptt_member(&pressed_mask, 1, full_mask));

        assert!(release_ptt_member(&pressed_mask, 0));
        assert_eq!(pressed_mask.load(Ordering::SeqCst), 0b10);
        assert!(!release_ptt_member(&pressed_mask, 0));
        assert!(press_ptt_member(&pressed_mask, 0, full_mask));
    }

    #[test]
    fn parses_legacy_normal_and_modifier_only_ptt_settings() {
        let legacy = ptt_key_config("ShiftRight");
        assert_eq!(legacy.setting, "ShiftRight");
        assert_eq!(legacy.vk_codes, vec![0xA1]);
        assert_eq!(legacy.modifier_mask, 0b1);

        let normal_combo = ptt_key_config("ControlLeft+KeyK");
        assert_eq!(normal_combo.vk_codes, vec![0xA2, 0x4B]);
        assert_eq!(normal_combo.modifier_mask, 0b01);

        let modifier_combo = ptt_key_config("ControlLeft+MetaLeft");
        assert_eq!(modifier_combo.vk_codes, vec![0xA2, 0x5B]);
        assert_eq!(modifier_combo.modifier_mask, 0b11);
    }

    #[test]
    fn invalid_ptt_setting_safely_falls_back_to_the_default_key() {
        let config = ptt_key_config("ControlLeft+UnknownKey");
        assert_eq!(config.setting, DEFAULT_PTT_SETTING);
        assert_eq!(config.vk_codes, vec![DEFAULT_PTT_VK]);
        assert_eq!(config.modifier_mask, 0b1);

        let duplicate_family = ptt_key_config("ControlLeft+ControlRight+KeyK");
        assert_eq!(duplicate_family.setting, DEFAULT_PTT_SETTING);
        assert_eq!(duplicate_family.vk_codes, vec![DEFAULT_PTT_VK]);
    }

            #[test]
    fn default_ptt_key_is_never_shift() {
        assert!(!DEFAULT_PTT_SETTING.contains("Shift"));
        assert_ne!(DEFAULT_PTT_VK, 0xA0);
        assert_ne!(DEFAULT_PTT_VK, 0xA1);
        assert_eq!(ptt_key_config(DEFAULT_PTT_SETTING).setting, DEFAULT_PTT_SETTING);
    }

            #[test]
    fn legacy_shift_binding_still_parses() {
        let legacy = ptt_key_config("ShiftRight");
        assert_eq!(legacy.setting, "ShiftRight");
        assert_eq!(legacy.vk_codes, vec![0xA1]);
    }

    #[test]
    fn release_must_be_queued_before_the_next_ptt_run_can_start() {
        let active_generation = AtomicU64::new(0);
        let generation = AtomicU64::new(0);

        let old_gen = begin_ptt_press(&active_generation, &generation).expect("old run starts");
        assert_eq!(claim_ptt_release(&active_generation, Some(old_gen)), Some(old_gen));
        assert!(begin_ptt_press(&active_generation, &generation).is_none());
        assert!(complete_ptt_release(&active_generation, old_gen));

        let new_gen = begin_ptt_press(&active_generation, &generation).expect("new run starts");
        assert_ne!(new_gen, old_gen);
        assert!(claim_ptt_release(&active_generation, Some(old_gen)).is_none());
        assert_eq!(active_generation.load(Ordering::SeqCst), new_gen);
        assert_eq!(claim_ptt_release(&active_generation, Some(new_gen)), Some(new_gen));
        assert!(complete_ptt_release(&active_generation, new_gen));
    }

    #[cfg(windows)]
    #[test]
    fn disconnected_dispatcher_releases_native_ptt_state() {
        let active_generation = AtomicU64::new(0);
        let generation = AtomicU64::new(20);
        let active_gen =
            begin_ptt_press(&active_generation, &generation).expect("run starts");
        let (sender, receiver) = std::sync::mpsc::channel();
        drop(receiver);

        assert!(!queue_ptt_release(
            &sender,
            &active_generation,
            Some(active_gen),
            0xA1,
            "keyup",
        ));
        assert_eq!(active_generation.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn watchdog_release_requires_the_active_generation() {
        let active_generation = AtomicU64::new(0);
        let generation = AtomicU64::new(40);

        let active_gen =
            begin_ptt_press(&active_generation, &generation).expect("run starts");
        assert!(claim_ptt_release(&active_generation, Some(active_gen + 2)).is_none());
        assert_eq!(active_generation.load(Ordering::SeqCst), active_gen);
        assert_eq!(claim_ptt_release(&active_generation, Some(active_gen)), Some(active_gen));
        assert!(complete_ptt_release(&active_generation, active_gen));
    }

        ///
                #[test]
    fn is_mouse_vk_covers_every_mouse_button_in_the_key_table() {
        for (code, vk) in SINGLE_KEY_TABLE {
            let listed_as_mouse = is_mouse_button_setting(code);
            assert_eq!(
                listed_as_mouse,
                is_mouse_vk(*vk),
                "{code} (vk={vk:#04x}): is_mouse_button_setting={listed_as_mouse} \
                 but is_mouse_vk={}; both classifications must agree",
                is_mouse_vk(*vk),
            );
        }
    }

        ///
                        #[test]
    fn bare_press_rule_covers_main_keys_and_spares_modifiers() {
        for (code, vk) in SINGLE_KEY_TABLE {
            let is_modifier = modifier_kind(code).is_some();
            let is_mouse = is_mouse_button_setting(code);
            let expected = !is_modifier && !is_mouse;
            assert_eq!(
                single_key_requires_bare_press(*vk),
                expected,
                "{code} (vk={vk:#04x}): modifier={is_modifier} mouse={is_mouse}; \
                 expected requires_bare_press={expected}",
            );
        }
    }

        #[test]
    fn bare_press_rule_named_cases() {
        assert!(single_key_requires_bare_press(0x73), "F4 is a main key and requires a bare press");
        assert!(single_key_requires_bare_press(0x20), "Space is a main key");
        assert!(single_key_requires_bare_press(0xA6), "BrowserBack uses the keyboard hook and is a main key");
        assert!(!single_key_requires_bare_press(0xA3), "Right Ctrl is the default PTT modifier and is exempt");
        assert!(!single_key_requires_bare_press(0xA5), "Right Alt is the hands-free default and part of AltGr");
        assert!(!single_key_requires_bare_press(0x05), "Mouse side buttons use the mouse hook and are exempt");
    }

            #[test]
    fn mouse_buttons_are_single_key_only() {
        for combo in ["XButton1+KeyA", "ControlLeft+XButton1", "MButton+ShiftLeft"] {
            let config = ptt_key_config(combo);
            assert_ne!(
                config.setting, combo,
                "{combo} must reject this combination; mouse buttons are single-key only",
            );
        }
        for single in ["XButton1", "XButton2", "MButton"] {
            let config = ptt_key_config(single);
            assert_eq!(config.setting, single, "{single} must be a valid single-key setting");
            assert_eq!(config.vk_codes.len(), 1, "{single} must contain exactly one key");
        }
    }

        ///
                    #[test]
    fn function_keys_f1_through_f24_are_all_present_with_contiguous_vks() {
        for n in 1..=24_u32 {
            let code = format!("F{n}");
            let expected_vk = 0x70 + n - 1;
            let found = SINGLE_KEY_TABLE
                .iter()
                .find(|(setting, _)| *setting == code.as_str());
            let Some((_, vk)) = found else {
                panic!("{code} is missing from SINGLE_KEY_TABLE; frontend F1-F24 keys must agree");
            };
            assert_eq!(
                *vk, expected_vk,
                "{code} must have vk {expected_vk:#04x}; VK_F1 through VK_F24 are consecutive",
            );

            let config = ptt_key_config(&code);
            assert_eq!(config.setting, code, "{code} must be accepted as a single key without fallback");
            assert_eq!(config.vk_codes, vec![expected_vk], "{code} must resolve to the matching vk");
        }
    }

        ///
            #[test]
    fn injection_exempt_vks_cover_f13_to_f24_and_side_button_remaps() {
        for vk in 0x7C..=0x87_u32 {
            assert!(is_injection_exempt_vk(vk), "{vk:#04x} in F13-F24 must be injection-exempt");
        }
        assert!(is_injection_exempt_vk(0xA6), "BrowserBack must be injection-exempt");
        assert!(is_injection_exempt_vk(0xA7), "BrowserForward must be injection-exempt");

        assert!(!is_injection_exempt_vk(0x7B), "F12 must not be injection-exempt");
        assert!(!is_injection_exempt_vk(0x88), "0x88 exceeds F24 and must not be injection-exempt");
        assert!(!is_injection_exempt_vk(0xA4), "Left Alt must never be injection-exempt");
        assert!(!is_injection_exempt_vk(0xA5), "Right Alt must never be injection-exempt");
    }
}
