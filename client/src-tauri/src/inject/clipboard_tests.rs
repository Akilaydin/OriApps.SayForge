//! Real clipboard tests run only on disposable Windows CI, never on a user's desktop.
use super::*;
use windows::core::w;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetWindowTextW, HWND_MESSAGE, WINDOW_EX_STYLE,
    WINDOW_STYLE, WS_POPUP, WS_VISIBLE,
};

struct TestWindow(HWND);

impl TestWindow {
    unsafe fn new() -> Self {
        assert_eq!(std::env::var("GITHUB_ACTIONS").as_deref(), Ok("true"));
        Self(CreateWindowExW(
            WINDOW_EX_STYLE::default(), w!("STATIC"), w!("SayForge clipboard test"),
            WINDOW_STYLE::default(), 0, 0, 0, 0, HWND_MESSAGE, None, None, None,
        ).unwrap())
    }
}

impl Drop for TestWindow {
    fn drop(&mut self) {
        unsafe { let _ = DestroyWindow(self.0); }
    }
}

unsafe fn put_fixture(owner: HWND, text: &str) {
    let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    let bytes = std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
    let handle = allocate_clipboard_bytes(bytes).unwrap();
    OpenClipboard(owner).unwrap();
    EmptyClipboard().unwrap();
    SetClipboardData(13, HANDLE(handle.0)).unwrap();
    CloseClipboard().unwrap();
}

#[test]
#[ignore = "changes the system clipboard; disposable Windows CI only"]
fn protected_write_records_the_closed_clipboard_version() {
    unsafe {
        let owner = TestWindow::new();
        put_fixture(owner.0, "Original synthetic clipboard");
        let (_, sequence) = set_clipboard_preserving("Synthetic dictation", None, owner.0, 1, 0)
            .unwrap_or_else(|(reason, _)| panic!("{reason}"));
        assert_eq!(sequence, GetClipboardSequenceNumber(), "stored version must identify the committed clipboard");
        assert_eq!(native_get_clipboard_text().as_deref(), Some("Synthetic dictation"));
        assert_eq!(sequence, GetClipboardSequenceNumber(), "our verification read must retain the same version");
    }
}

#[test]
#[ignore = "changes the system clipboard; disposable Windows CI only"]
fn fallback_copy_writes_exact_unicode() {
    unsafe {
        let owner = TestWindow::new();
        put_fixture(owner.0, "previous synthetic clipboard");
        let text = "Synthetic: Привет 😀\r\n第二行";
        assert!(set_clipboard_with_retry_pub(text, 1, 0, owner.0.0 as isize));
        assert_eq!(native_get_clipboard_text().as_deref(), Some(text));
    }
}

#[test]
#[ignore = "changes the system clipboard; disposable Windows CI only"]
fn failed_write_keeps_previous_clipboard_contents() {
    unsafe {
        let owner = TestWindow::new();
        let previous = "Previous synthetic text must survive a failed Copy";
        put_fixture(owner.0, previous);
        let format = windows::Win32::System::DataExchange::RegisterClipboardFormatW(w!("SayForge synthetic test format"));
        let custom = b"synthetic custom format";
        let handle = allocate_clipboard_bytes(custom).unwrap();
        OpenClipboard(owner.0).unwrap();
        SetClipboardData(format, HANDLE(handle.0)).unwrap();
        CloseClipboard().unwrap();
        FAIL_NEXT_CLIPBOARD_WRITE.with(|flag| flag.set(true));
        assert!(!set_clipboard_with_retry_pub("Replacement", 1, 0, owner.0.0 as isize));
        assert_eq!(native_get_clipboard_text().as_deref(), Some(previous));
        OpenClipboard(owner.0).unwrap();
        let restored = HGLOBAL(GetClipboardData(format).unwrap().0);
        let ptr = GlobalLock(restored);
        assert!(!ptr.is_null());
        assert_eq!(std::slice::from_raw_parts(ptr as *const u8, custom.len()), custom);
        let _ = GlobalUnlock(restored);
        CloseClipboard().unwrap();
    }
}

#[test]
#[ignore = "changes the system clipboard; disposable Windows CI only"]
fn unavailable_clipboard_and_missing_owner_leave_contents_unchanged() {
    unsafe {
        let owner = TestWindow::new();
        let previous = "Synthetic clipboard held by another thread";
        put_fixture(owner.0, previous);
        assert!(!set_clipboard_with_retry_pub("Replacement", 1, 0, 0));
        assert_eq!(native_get_clipboard_text().as_deref(), Some(previous));

        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let held = TestWindow::new();
            OpenClipboard(held.0).unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            CloseClipboard().unwrap();
        });
        ready_rx.recv().unwrap();
        let copied = set_clipboard_with_retry_pub("Replacement", 1, 0, owner.0.0 as isize);
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert!(!copied);
        assert_eq!(native_get_clipboard_text().as_deref(), Some(previous));
    }
}

#[test]
#[ignore = "changes the system clipboard and creates an editor; disposable Windows CI only"]
fn unprotected_paste_inserts_into_a_synthetic_win32_editor() {
    unsafe {
        let owner = TestWindow::new();
        let editor = TestWindow(CreateWindowExW(
            WINDOW_EX_STYLE::default(), w!("EDIT"), w!(""), WS_POPUP | WS_VISIBLE,
            0, 0, 200, 80, None, None, None, None,
        ).unwrap());
        put_fixture(owner.0, "Previous synthetic clipboard");
        let text = "Synthetic Привет 😀";
        let result = do_inject(editor.0, editor.0, text, false, owner.0);
        assert!(result.ok, "{:?}: {:?}", result.reason, result.detail);
        assert_eq!(result.strategy.as_deref(), Some("wm_paste"));
        let mut contents = [0u16; 128];
        let length = GetWindowTextW(editor.0, &mut contents) as usize;
        assert_eq!(String::from_utf16(&contents[..length]).unwrap(), text);
        assert_eq!(native_get_clipboard_text().as_deref(), Some(text));
        assert!(PENDING_CLIPBOARD.lock().unwrap().is_none());
    }
}

#[test]
#[ignore = "changes the system clipboard; disposable Windows CI only"]
fn explicit_copy_supersedes_protected_paste_restoration() {
    unsafe {
        let owner = TestWindow::new();
        put_fixture(owner.0, "Previous synthetic clipboard");
        {
            let _lock = PASTE_LOCK.lock().unwrap();
            let id = PASTE_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
            assert!(replace_clipboard("Protected paste", true, owner.0, id, 1, 0));
            assert!(PENDING_CLIPBOARD.lock().unwrap().is_some());
        }
        assert!(set_clipboard_with_retry_pub("Explicit copy", 1, 0, owner.0.0 as isize));
        assert!(PENDING_CLIPBOARD.lock().unwrap().is_none());
        assert_eq!(native_get_clipboard_text().as_deref(), Some("Explicit copy"));
    }
}
