//! Prüfstand-Hülle um BeeKEM (Keyhives CGKA): nur Schlüsselvereinbarung,
//! die Mitgliedschaft entscheidet die App (bei uns das Autoritätslog).
pub mod peer;
#[cfg(target_arch = "wasm32")]
mod wasm;
