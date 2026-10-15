//! E14a: Testvektoren für MLS zu zweit mit anderen Implementierungen (Consensual, OpenVTC).
//! Rohe MLSMessage-Bytes (TLS-serialisiert) als Hex; der Zustand eines Peers liegt in einer Datei.
//!
//!   vectors <zustand> init                      neuer Peer; gibt sein KeyPackage (Hex) aus
//!   vectors <zustand> create <gruppe-hex>       Gruppe gründen
//!   vectors <zustand> add <keypackage-hex>      Mitglied aufnehmen; gibt {"commit","welcome"} (Hex) aus
//!   vectors <zustand> join <welcome-hex>        über ein Welcome beitreten
//!   vectors <zustand> commit <commit-hex>       fremden Commit einspielen; gibt das Ergebnis aus
//!   vectors <zustand> send <text>               Anwendungsnachricht (PrivateMessage) erzeugen, Hex
//!   vectors <zustand> open <nachricht-hex>      Anwendungsnachricht öffnen, Klartext
//!   vectors <zustand> info                      Epoche, Mitglieder
//!
//! Parameter: Ciphersuite 0x0001 (MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519), Basic Credential,
//! Ratchet-Tree-Extension im Welcome, OpenMLS 0.9.1.

use mls_wasm::peer::{Error, Peer};
use std::fs;

fn load(path: &str) -> Peer {
    let bytes = fs::read(path).expect("Zustand lesen");
    Peer::from_state(&bytes).expect("Zustand laden")
}

fn save(path: &str, p: &Peer) {
    fs::write(path, p.export_state().expect("Zustand exportieren")).expect("Zustand schreiben");
}

fn arg(args: &[String], i: usize, what: &str) -> String {
    args.get(i).cloned().unwrap_or_else(|| panic!("fehlt: {what}"))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let state = arg(&args, 1, "Zustandsdatei");
    let cmd = arg(&args, 2, "Befehl");
    match cmd.as_str() {
        "init" => {
            let p = Peer::new().expect("Peer");
            save(&state, &p);
            println!("{}", hex::encode(p.share_key()));
        }
        "create" => {
            let mut p = load(&state);
            let gid = hex::decode(arg(&args, 3, "Gruppen-ID (Hex)")).expect("Hex");
            p.create(&gid).expect("gründen");
            save(&state, &p);
            println!("ok epoch={}", p.epoch());
        }
        "add" => {
            let mut p = load(&state);
            let kp = hex::decode(arg(&args, 3, "KeyPackage (Hex)")).expect("Hex");
            let (commit, welcome) = p.add(&kp).expect("aufnehmen");
            save(&state, &p);
            let (_, c) = Peer::unwrap_op(&commit).expect("commit");
            let (_, w) = Peer::unwrap_op(&welcome).expect("welcome");
            println!("{{\"commit\":\"{}\",\"welcome\":\"{}\"}}", hex::encode(c), hex::encode(w));
        }
        "join" => {
            let mut p = load(&state);
            let w = hex::decode(arg(&args, 3, "Welcome (Hex)")).expect("Hex");
            let r = p.welcome(&w).expect("beitreten");
            save(&state, &p);
            println!("{r:?} epoch={}", p.epoch());
        }
        "commit" => {
            let mut p = load(&state);
            let c = hex::decode(arg(&args, 3, "Commit (Hex)")).expect("Hex");
            let r = match p.receive(&Peer::wrap_commit(c).expect("wrap")) {
                Ok(()) => "ok".to_string(),
                Err(Error::Own) => "own".into(),
                Err(Error::LostTiebreak) => "lost".into(),
                Err(Error::Stale(s)) => format!("stale: {s}"),
                Err(e) => {
                    // Nicht anwendbar: Zustand unverändert lassen, mit Fehlerstatus beenden (CodeRabbit zu #40).
                    eprintln!("fehler: {e}");
                    std::process::exit(2);
                }
            };
            save(&state, &p);
            println!("{r} epoch={}", p.epoch());
        }
        "send" => {
            let mut p = load(&state);
            let m = p.send_message(arg(&args, 3, "Text").as_bytes()).expect("senden");
            save(&state, &p);
            println!("{}", hex::encode(m));
        }
        "open" => {
            let mut p = load(&state);
            let m = hex::decode(arg(&args, 3, "Nachricht (Hex)")).expect("Hex");
            let plain = p.open_message(&m).expect("öffnen");
            save(&state, &p);
            println!("{}", String::from_utf8_lossy(&plain));
        }
        "info" => {
            let p = load(&state);
            println!("epoch={} members={}", p.epoch(), p.members().iter().map(hex::encode).collect::<Vec<_>>().join(","));
        }
        other => panic!("unbekannter Befehl {other}"),
    }
}
