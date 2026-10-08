//! English-only UI locale, including the Tauri tray and diagnostics.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
}

impl Lang {
    pub fn tag(self) -> &'static str {
        "en"
    }
}

pub fn system_ui_lang() -> Lang {
    Lang::En
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_is_always_the_ui_locale() {
        assert_eq!(system_ui_lang(), Lang::En);
        assert_eq!(system_ui_lang().tag(), "en");
    }
}
