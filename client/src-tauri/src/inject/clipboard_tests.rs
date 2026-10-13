//! Real clipboard tests run only on disposable Windows CI, never on a user's desktop.
use super::*;
use windows::core::w;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE,
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
fn fallback_copy_writes_exact_unicode() {
    unsafe {
        let owner = TestWindow::new();
        put_fixture(owner.0, "previous synthetic clipboard");
        let text = "Synthetic: Привет 😀\r\n第二行";
        assert!(set_clipboard_with_retry_pub(text, 1, 0));
        assert_eq!(native_get_clipboard_text().as_deref(), Some(text));
    }
}
