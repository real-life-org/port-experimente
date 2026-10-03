//! Prüfstand-Hülle um p2panda-spaces 0.7.1 (siehe vendor/README.md).
pub mod peer;
#[cfg(target_arch = "wasm32")]
mod wasm;
