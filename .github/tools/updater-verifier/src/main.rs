use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::{error::Error, ffi::OsString, fs, path::Path};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

// Match tauri-plugin-updater 2.10.0: both config pubkey and .sig contain
// Base64-encoded Minisign text, and legacy signatures are accepted.
fn verify_bytes(installer: &[u8], signature_b64: &str, pubkey_b64: &str) -> Result<()> {
    let key_text = String::from_utf8(STANDARD.decode(pubkey_b64.trim())?)?;
    let signature_text = String::from_utf8(STANDARD.decode(signature_b64.trim())?)?;
    let key = PublicKey::decode(&key_text)?;
    let signature = Signature::decode(&signature_text)?;
    key.verify(installer, &signature, true)?;
    Ok(())
}

fn verify_files(installer_path: &Path, signature_path: &Path, config_path: &Path) -> Result<()> {
    let config: serde_json::Value = serde_json::from_slice(&fs::read(config_path)?)?;
    let pubkey = config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .ok_or("Missing plugins.updater.pubkey in Tauri config")?;
    let signature = fs::read_to_string(signature_path)?;
    let installer = fs::read(installer_path)?;
    verify_bytes(&installer, &signature, pubkey)
}

fn run() -> Result<()> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err("Usage: sayforge-updater-verifier <installer.exe> <installer.exe.sig> <tauri.conf.json>".into());
    }
    verify_files(
        Path::new(&args[0]),
        Path::new(&args[1]),
        Path::new(&args[2]),
    )
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Updater signature verification failed: {error}");
        std::process::exit(1);
    }
    println!("Updater signature verified against Tauri's configured public key.");
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSTALLER: &[u8] = include_bytes!("../fixtures/installer.bin");
    const PUBKEY: &str = include_str!("../fixtures/trusted.pub");
    const SIGNATURE: &str = include_str!("../fixtures/trusted.sig");
    const ALTERNATE_PUBKEY: &str = include_str!("../fixtures/other-key.pub");
    const ALTERNATE_SIGNATURE: &str = include_str!("../fixtures/other-key.sig");

    #[test]
    fn accepts_a_valid_signature_from_the_trusted_key() {
        verify_bytes(INSTALLER, SIGNATURE, PUBKEY).unwrap();
    }

    #[test]
    fn rejects_a_valid_signature_from_another_key() {
        verify_bytes(INSTALLER, ALTERNATE_SIGNATURE, ALTERNATE_PUBKEY).unwrap();
        assert!(verify_bytes(INSTALLER, ALTERNATE_SIGNATURE, PUBKEY).is_err());
    }

    #[test]
    fn rejects_modified_installer_bytes() {
        let mut altered = INSTALLER.to_vec();
        altered[0] ^= 0x01;
        assert!(verify_bytes(&altered, SIGNATURE, PUBKEY).is_err());
    }

    #[test]
    fn rejects_malformed_key_and_signature() {
        assert!(verify_bytes(INSTALLER, SIGNATURE, "not Base64").is_err());
        assert!(verify_bytes(INSTALLER, "not Base64", PUBKEY).is_err());
    }
}
