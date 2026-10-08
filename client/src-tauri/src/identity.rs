//! Identity of this independent SayForge distribution.
//!
//! Keep app data paths separate from the original SayIt distribution. Changing
//! the Tauri identifier alone is not enough because some paths are explicit.
pub const APP_ID: &str = "com.oriapps.sayforge";
pub const APP_NAME: &str = "SayForge";
pub const DATABASE_FILE: &str = "sayforge.db";
pub const LOG_FILE: &str = "sayforge.log";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_identity_cannot_use_the_upstream_data_directory() {
        assert_ne!(APP_ID, "com.sayit.app");
        assert_ne!(DATABASE_FILE, "sayit.db");
        assert_ne!(LOG_FILE, "sayit.log");
    }
}
