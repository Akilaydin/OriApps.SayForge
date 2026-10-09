use std::path::{Path, PathBuf};

fn main() {
    // "glob pattern transcribe-libs/* path not found or didn't match any files"。
    stage_transcribe_runtime_libs();

    tauri_build::build();
}

///
///
fn stage_transcribe_runtime_libs() {
    println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_RUNTIME_DIR");
    println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_MODULE_DIR");

    let Some(runtime_dir) = std::env::var_os("DEP_TRANSCRIBE_CPP_RUNTIME_DIR") else {
        return;
    };

    let mut dirs = vec![PathBuf::from(runtime_dir)];
    if let Some(module_dir) = std::env::var_os("DEP_TRANSCRIBE_CPP_MODULE_DIR") {
        let p = PathBuf::from(module_dir);
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("Unexpected OUT_DIR layout")
        .to_path_buf();

    let staging = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("transcribe-libs");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).expect("Could not create the transcribe-libs directory");

    let mut copied = 0usize;
    for dir in &dirs {
        println!("cargo:rerun-if-changed={}", dir.display());
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let src = entry.path();
            let name = match src.file_name().and_then(|s| s.to_str()) {
                Some(n) if n.ends_with(".dll") => n.to_string(),
                _ => continue,
            };
            copy_to(&src, &profile_dir, &name);
            copy_to(&src, &staging, &name);
            copied += 1;
        }
    }

    if copied == 0 {
        panic!(
            "transcribe-cpp requires shared/dynamic backends, but no DLLs were found in {dirs:?};\
             the package would register no compute devices and local GGUF recognition would fail"
        );
    }
    println!("cargo:warning=staged {copied} transcribe/ggml DLL(s)");

    let crt = stage_vc_redist(&profile_dir, &staging);
    println!("cargo:warning=staged {crt} VC++ runtime DLL(s)");
}

fn copy_to(src: &Path, dir: &Path, name: &str) {
    if let Err(e) = std::fs::copy(src, dir.join(name)) {
        println!("cargo:warning=copy {name} -> {} failed: {e}", dir.display());
    }
}

///
///
fn stage_vc_redist(profile_dir: &Path, staging: &Path) -> usize {
    println!("cargo:rerun-if-env-changed=SAYIT_VC_REDIST_DIRS");
    println!("cargo:rerun-if-env-changed=SAYIT_SKIP_VC_REDIST");
    println!("cargo:rerun-if-env-changed=VCToolsRedistDir");

    if std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default() != "msvc" {
        return 0;
    }
    if std::env::var_os("SAYIT_SKIP_VC_REDIST").is_some() {
        println!(
            "cargo:warning=SAYIT_SKIP_VC_REDIST is set; VC++ runtime DLLs will not be bundled.\
             The application may crash on machines with older VC++ runtimes. Do not release this package."
        );
        return 0;
    }

    let dirs = resolve_vc_redist_dirs().unwrap_or_else(|| {
        panic!(
            "Could not locate the VC++ redistributable directory required to bundle MSVCP140 and VCRUNTIME140.\
             Without these libraries, init_backends() may crash (0xc0000005) on other machines.\n\
             Fix the installation using the MSVC v143 build tools in Visual Studio Installer,\
             or set SAYIT_VC_REDIST_DIRS to the CRT/OpenMP DLL folders.\
             For local testing only, set SAYIT_SKIP_VC_REDIST=1 to build without redistribution."
        )
    });

    let mut copied = 0usize;
    for dir in &dirs {
        println!("cargo:rerun-if-changed={}", dir.display());
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let src = entry.path();
            let name = match src.file_name().and_then(|s| s.to_str()) {
                Some(n) if n.to_ascii_lowercase().ends_with(".dll") => n.to_string(),
                _ => continue,
            };
            copy_to(&src, profile_dir, &name);
            copy_to(&src, staging, &name);
            copied += 1;
        }
    }

    if copied == 0 {
        panic!("No VC++ runtime DLLs were found in {dirs:?}; check the Visual Studio installation");
    }
    copied
}

///
fn resolve_vc_redist_dirs() -> Option<Vec<PathBuf>> {
    if let Some(v) = std::env::var_os("SAYIT_VC_REDIST_DIRS") {
        let list: Vec<PathBuf> = v
            .to_string_lossy()
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .collect();
        if !list.is_empty() {
            return Some(list);
        }
    }

    let redist_root = vc_redist_root()?;
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH")
        .unwrap_or_default()
        .as_str()
    {
        "aarch64" => "arm64",
        "x86" => "x86",
        _ => "x64",
    };
    let arch_dir = redist_root.join(arch);

    let crt = newest_redist_subdir(&arch_dir, ".crt")?;
    let mut dirs = vec![crt];
    if let Some(omp) = newest_redist_subdir(&arch_dir, ".openmp") {
        dirs.push(omp);
    }
    Some(dirs)
}

fn vc_redist_root() -> Option<PathBuf> {
    if let Some(v) = std::env::var_os("VCToolsRedistDir") {
        let p = PathBuf::from(v);
        if p.is_dir() {
            return Some(p);
        }
    }

    let program_files_x86 = std::env::var("ProgramFiles(x86)")
        .or_else(|_| std::env::var("ProgramFiles"))
        .ok()?;
    let vswhere = PathBuf::from(program_files_x86)
        .join("Microsoft Visual Studio")
        .join("Installer")
        .join("vswhere.exe");
    if !vswhere.is_file() {
        return None;
    }

    let out = std::process::Command::new(&vswhere)
        .args(["-latest", "-products", "*", "-property", "installationPath"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let vs_root = PathBuf::from(
        stdout
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())?,
    );

    let version = std::fs::read_to_string(
        vs_root
            .join("VC")
            .join("Auxiliary")
            .join("Build")
            .join("Microsoft.VCRedistVersion.default.txt"),
    )
    .ok()?;
    let root = vs_root
        .join("VC")
        .join("Redist")
        .join("MSVC")
        .join(version.trim());
    if root.is_dir() {
        Some(root)
    } else {
        None
    }
}

fn newest_redist_subdir(arch_dir: &Path, suffix: &str) -> Option<PathBuf> {
    let mut hits: Vec<PathBuf> = std::fs::read_dir(arch_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            p.file_name()
                .and_then(|s| s.to_str())
                .map(|n| {
                    let n = n.to_ascii_lowercase();
                    n.starts_with("microsoft.vc") && n.ends_with(suffix)
                })
                .unwrap_or(false)
        })
        .collect();
    hits.sort();
    hits.pop()
}
