//! Identity of this independent SayForge distribution.
//!
//! Keep app data paths isolated from other applications. Changing the Tauri
//! identifier alone is not enough because some paths are explicit.
pub const APP_ID: &str = "com.oriapps.sayforge";
pub const APP_NAME: &str = "SayForge";
pub const DATABASE_FILE: &str = "sayforge.db";
pub const LOG_FILE: &str = "sayforge.log";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_has_independent_names() {
        assert_eq!(APP_ID, "com.oriapps.sayforge");
        assert_eq!(APP_NAME, "SayForge");
        assert_eq!(DATABASE_FILE, "sayforge.db");
        assert_eq!(LOG_FILE, "sayforge.log");
    }
}
