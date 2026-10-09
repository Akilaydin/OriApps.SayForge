//
//
pub const USER_AGENT: &str = concat!("SayForge/", env!("CARGO_PKG_VERSION"));

static SHARED: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

pub fn shared() -> &'static reqwest::Client {
    &SHARED
}
