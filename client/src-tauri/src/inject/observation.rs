//! Observe a focused editor's text length without fetching its text or value.

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
    TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start, TextUnit_Character,
    UIA_TextPatternId,
};

struct ComApartment(bool);

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

pub(super) struct PasteObservation {
    automation: IUIAutomation,
    editor: IUIAutomationElement,
    pattern: IUIAutomationTextPattern,
    pub before: usize,
    // Release the COM interfaces before balancing this thread's initialization.
    _apartment: ComApartment,
}

impl PasteObservation {
    pub unsafe fn capture(target: HWND) -> Option<Self> {
        let apartment = ComApartment(CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok());
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let editor = automation.GetFocusedElement().ok()?;
        // Unavailable password metadata also prevents observation.
        if editor.CurrentIsPassword().ok()?.as_bool() {
            return None;
        }
        let root = automation.ElementFromHandle(target).ok()?;
        let walker = automation.ControlViewWalker().ok()?;
        let mut ancestor = editor.clone();
        let mut belongs_to_target = false;
        for _ in 0..32 {
            if automation.CompareElements(&root, &ancestor).ok()?.as_bool() {
                belongs_to_target = true;
                break;
            }
            ancestor = walker.GetParentElement(&ancestor).ok()?;
        }
        if !belongs_to_target {
            return None;
        }
        let pattern: IUIAutomationTextPattern = editor.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
        let before = text_length(&pattern)?;
        Some(Self { automation, editor, pattern, before, _apartment: apartment })
    }

    pub unsafe fn focused(&self) -> bool {
        self.automation.GetFocusedElement().ok().and_then(|current| {
            self.automation.CompareElements(&self.editor, &current).ok()
        }).is_some_and(|same| same.as_bool())
    }

    pub unsafe fn length(&self) -> Option<usize> {
        text_length(&self.pattern)
    }
}

unsafe fn text_length(pattern: &IUIAutomationTextPattern) -> Option<usize> {
    // Move range endpoints only: no GetText, CurrentValue, selection or editor content.
    // Bound traversal; larger documents remain unconfirmed instead of being truncated.
    const LIMIT: i32 = 1_000_000;
    let range = pattern.DocumentRange().ok()?;
    range.MoveEndpointByRange(TextPatternRangeEndpoint_End, &range, TextPatternRangeEndpoint_Start).ok()?;
    let moved = range.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, LIMIT).ok()?;
    if moved < 0 || moved >= LIMIT {
        return None;
    }
    Some(moved as usize)
}
