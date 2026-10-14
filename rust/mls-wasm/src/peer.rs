//! MLS (RFC 9420, OpenMLS 0.9) als reiner Schlüssel-Adapter unter dem
//! Autoritätslog. Dieselbe Oberfläche wie `beekem-wasm`: ein Peer je Gerät,
//! Operationen als Bytes für die Leitung, Einträge unter einem
//! Eintragsschlüssel, der sich aus dem Epochen-Exporter und der Referenz
//! ableitet. Mitgliedschaft entscheidet niemand hier; Commits werden aus
//! Logeinträgen abgeleitet (Access §9.1), nie umgekehrt.
//!
//! MLS ist linear: je Epoche genau ein Commit. Der Vertrag zur Epochenwahl:
//!
//! 1. Commits bilden einen Baum über Epochen; je Epoche gilt der Commit mit
//!    dem kleinsten Hash (deterministisch für alle Repliken, unabhängig von
//!    der Reihenfolge; nur über Schlüssel, nie über Mitgliedschaft).
//! 2. Jede Replik hält Momentaufnahmen der letzten `SNAPSHOT_DEPTH` Epochen.
//!    Ein Commit auf eine schon verlassene Epoche wird gegen deren
//!    Momentaufnahme geprüft: hat er den kleineren Hash als der dort
//!    angewandte, fällt die Replik auf diese Epoche zurück, nimmt ihn und
//!    meldet `LostTiebreak`; sonst ist er `Stale`. Dieselbe Epochennummer
//!    heißt nicht derselbe Vorgänger: lässt sich der Commit auf dem Zustand
//!    dieser Epoche nicht anwenden, stammt er von einem anderen Zweig. Ob der
//!    gewinnt, entscheidet erst sein Vorgänger (der noch kommen kann): der
//!    Commit ist dann `Epoch` (noch nicht anwendbar, der Aufrufer puffert und
//!    versucht es nach jeder Änderung wieder), nicht `Stale`. Endgültig
//!    verfallen (`Stale`) ist nur, was tiefer zurückliegt, als die
//!    Momentaufnahmen reichen, oder was den Tiebreak auf seiner Epoche
//!    nachweislich verloren hat.
//! 3. Was nach einem Rückfall fehlt (Blätter, Entfernungen), stellt die
//!    Heilung des Kandidaten aus dem Log wieder her; Rahmen, die unter einer
//!    verfallenen Epoche versiegelt wurden, versiegelt ihr Autor neu.
//! 4. Ein Willkommen auf eine Epoche über der eigenen ersetzt die eigene
//!    Gruppe (sie stand auf einem verfallenen Zweig): `welcome` meldet das
//!    als `Reset`, damit der Kandidat seine Rahmen seit dem Beitritt neu
//!    versiegelt.

use std::collections::HashMap;

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use sha2::{Digest, Sha256};
use tls_codec::{Deserialize as _, Serialize as _};

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const EXPORTER_LABEL: &str = "rltp-entry-exporter";
/// Wie viele verlassene Epochen eine Replik noch zurückfallen kann (Vertrag Punkt 2).
pub const SNAPSHOT_DEPTH: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("keine Gruppe")]
    NoGroup,
    #[error("schon in einer Gruppe")]
    AlreadyInGroup,
    #[error("Mitglied nicht im Baum")]
    NotMember,
    #[error("eigene Operation")]
    Own,
    #[error("Operation passt nicht zur Epoche ({0})")]
    Epoch(String),
    #[error("Operation aus einer vergangenen Epoche ({0}): nie mehr anwendbar")]
    Stale(String),
    #[error("Konflikt verloren: eigener Commit zurückgerollt")]
    LostTiebreak,
    #[error("Willkommen auf eine höhere Epoche: eigene Gruppe ersetzt")]
    Reset,
    #[error("MLS: {0}")]
    Mls(String),
    #[error("Entschlüsselung")]
    Decrypt,
    #[error("Kodierung: {0}")]
    Codec(String),
}

fn mls<E: std::fmt::Display>(e: E) -> Error {
    Error::Mls(e.to_string())
}

/// Ein Rahmen auf der Leitung: Commit (an alle) oder Willkommen (an den Neuen).
#[derive(serde::Serialize, serde::Deserialize)]
enum Op {
    Commit { bytes: Vec<u8> },
    Welcome { bytes: Vec<u8> },
}

/// Versiegelter Eintrag: Epoche, Referenz, Nonce, Chiffretext (AES-256-GCM unter dem Eintragsschlüssel).
#[derive(serde::Serialize, serde::Deserialize)]
struct Sealed {
    epoch: u64,
    content_ref: Vec<u8>,
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
}

/// Ergebnis eines Willkommens: frisch beigetreten, oder eine laufende Gruppe ersetzt (verfallener Zweig).
#[derive(Debug, PartialEq, Eq)]
pub enum Welcomed {
    Joined,
    Reset,
}

struct Checkpoint {
    storage: HashMap<Vec<u8>, Vec<u8>>,
    exporters: HashMap<u64, [u8; 32]>,
    snapshots: Vec<Snapshot>,
}

pub struct Sealed2 {
    pub ciphertext: Vec<u8>,
    pub app_key: [u8; 32],
}

/// Momentaufnahme vor einem eingespielten Commit (eigen oder fremd), je
/// verlassener Epoche eine: Kommt ein Geschwister-Commit auf diese Epoche mit
/// kleinerem Hash, fällt die Replik hierher zurück und nimmt das Geschwister.
/// So wählen alle Repliken denselben Gewinner, auch die, die keinen der beiden
/// geschrieben haben.
#[derive(Clone)]
struct Snapshot {
    parent_epoch: u64,
    applied_hash: [u8; 32],
    storage: HashMap<Vec<u8>, Vec<u8>>,
    exporters: HashMap<u64, [u8; 32]>,
}

pub struct Peer {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    identity: Vec<u8>,
    credential: CredentialWithKey,
    /// Das eigene KeyPackage für Willkommen (serialisiert = „Share-Key“ der Karte).
    key_package: Vec<u8>,
    /// Dasselbe als Bündel mit Geheimnissen: wird nach einem Willkommen wieder in den Speicher gelegt, damit die Karte
    /// (deren Share-Key dieses KeyPackage ist) auch eine Wiederaufnahme trägt. MLS sieht ein KeyPackage als
    /// einmalig vor; die Wiederverwendung ist eine Prüfstand-Vereinfachung (Befund: Wiederaufnahme braucht in der
    /// Praxis eine frische Karte).
    bundle: Option<KeyPackageBundle>,
    group: Option<MlsGroup>,
    /// Exporter-Geheimnis je Epoche, solange der Peer dabei war: daraus die Eintragsschlüssel.
    exporters: HashMap<u64, [u8; 32]>,
    /// Digests eigener Operationen, damit das Echo von der Leitung nicht als fremd gilt.
    own: std::collections::HashSet<[u8; 32]>,
    /// Aufsteigend nach `parent_epoch`, höchstens `SNAPSHOT_DEPTH`.
    snapshots: Vec<Snapshot>,
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Hash eines Commit-Rahmens, wie ihn der Tiebreak vergleicht (für Tests).
pub fn digest_of(op_bytes: &[u8]) -> [u8; 32] {
    match bincode::deserialize::<Op>(op_bytes) {
        Ok(Op::Commit { bytes }) => digest(&bytes),
        _ => [0xff; 32],
    }
}

impl Peer {
    pub fn new() -> Result<Self, Error> {
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(mls)?;
        signer.store(provider.storage()).map_err(mls)?;
        let identity: Vec<u8> = {
            use openmls_traits::random::OpenMlsRand;
            provider.rand().random_vec(16).map_err(mls)?
        };
        let credential: Credential = BasicCredential::new(identity.clone()).into();
        let credential = CredentialWithKey { credential, signature_key: signer.to_public_vec().into() };
        let mut p = Peer { provider, signer, identity, credential, key_package: Vec::new(), bundle: None, group: None, exporters: HashMap::new(), own: Default::default(), snapshots: Vec::new() };
        let bundle = KeyPackage::builder()
            .build(CIPHERSUITE, &p.provider, &p.signer, p.credential.clone())
            .map_err(mls)?;
        p.key_package = MlsMessageOut::from(bundle.key_package().clone()).tls_serialize_detached().map_err(|e| Error::Codec(e.to_string()))?;
        p.bundle = Some(bundle);
        Ok(p)
    }

    /// Das verbrauchte KeyPackage wieder bereitlegen (s. `bundle`).
    fn restore_key_package(&self) -> Result<(), Error> {
        use openmls_traits::storage::StorageProvider as _;
        if let Some(b) = self.bundle.as_ref() {
            let r = b.key_package().hash_ref(self.provider.crypto()).map_err(mls)?;
            self.provider.storage().write_key_package(&r, b).map_err(mls)?;
        }
        Ok(())
    }

    pub fn id(&self) -> &[u8] {
        &self.identity
    }

    /// Das KeyPackage als Bytes: was die Karte als Share-Key trägt.
    pub fn share_key(&self) -> &[u8] {
        &self.key_package
    }

    fn group(&self) -> Result<&MlsGroup, Error> {
        self.group.as_ref().ok_or(Error::NoGroup)
    }

    fn remember_exporter(&mut self) -> Result<(), Error> {
        let g = self.group()?;
        let epoch = g.epoch().as_u64();
        let secret = g.export_secret(self.provider.crypto(), EXPORTER_LABEL, &[], 32).map_err(mls)?;
        let mut key = [0u8; 32];
        key.copy_from_slice(&secret);
        self.exporters.insert(epoch, key);
        Ok(())
    }

    /// Gruppe gründen; MLS erzeugt dafür keine Nachricht an andere.
    pub fn create(&mut self, group_id: &[u8]) -> Result<Vec<Vec<u8>>, Error> {
        if self.group.is_some() {
            return Err(Error::AlreadyInGroup);
        }
        let config = MlsGroupCreateConfig::builder().ciphersuite(CIPHERSUITE).use_ratchet_tree_extension(true).build();
        let g = MlsGroup::new_with_group_id(&self.provider, &self.signer, &config, GroupId::from_slice(group_id), self.credential.clone()).map_err(mls)?;
        self.group = Some(g);
        self.remember_exporter()?;
        Ok(Vec::new())
    }

    /// Beitritt über das Willkommen (MLS kennt kein Beitreten ohne). Nach einer Entfernung (Gruppe inaktiv)
    /// nimmt ein neues Willkommen wieder auf (`Joined`). Steht die eigene Gruppe noch und das Willkommen zeigt
    /// auf eine höhere Epoche, ersetzt es sie (`Reset`, Vertrag Punkt 4); sonst `Own` (schon drin).
    pub fn welcome(&mut self, bytes: &[u8]) -> Result<Welcomed, Error> {
        let msg = MlsMessageIn::tls_deserialize_exact(bytes).map_err(|e| Error::Codec(e.to_string()))?;
        let welcome = match msg.extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => return Err(Error::Codec("kein Willkommen".into())),
        };
        // OpenMLS lehnt schon das Prüfen eines Willkommens ab, solange eine Gruppe mit derselben GroupId im
        // Speicher liegt. Deshalb: Speicher sichern, Gruppe herausnehmen, prüfen; wenn das Willkommen nicht gilt,
        // den Speicher zurücklegen.
        let backup = self.provider.storage().values.read().map_err(|_| Error::Mls("storage lock".into()))?.clone();
        let (gid, old) = match self.group.take() {
            Some(mut g) => {
                let old = g.is_active().then(|| g.epoch().as_u64());
                let gid = g.group_id().clone();
                g.delete(self.provider.storage()).map_err(mls)?;
                (Some(gid), old)
            }
            None => (None, None),
        };
        let config = MlsGroupJoinConfig::builder().use_ratchet_tree_extension(true).build();
        let staged = match StagedWelcome::new_from_welcome(&self.provider, &config, welcome, None) {
            Ok(st) => st,
            Err(e) => {
                self.restore_storage(backup, gid.as_ref())?;
                return Err(mls(e));
            }
        };
        let target = staged.group_context().epoch().as_u64();
        let mut outcome = Welcomed::Joined;
        if let Some(current) = old {
            if target <= current {
                self.restore_storage(backup, gid.as_ref())?;
                return Err(Error::Own);
            }
            outcome = Welcomed::Reset;
        }
        self.snapshots.clear();
        self.exporters.clear();
        let g = staged.into_group(&self.provider).map_err(mls)?;
        self.group = Some(g);
        self.remember_exporter()?;
        self.restore_key_package()?;
        Ok(outcome)
    }

    fn restore_storage(&mut self, backup: HashMap<Vec<u8>, Vec<u8>>, gid: Option<&GroupId>) -> Result<(), Error> {
        *self.provider.storage().values.write().map_err(|_| Error::Mls("storage lock".into()))? = backup;
        if let Some(gid) = gid {
            self.group = MlsGroup::load(self.provider.storage(), gid).map_err(mls)?;
        }
        Ok(())
    }

    /// Aktuelle Epoche (0 ohne Gruppe).
    pub fn epoch(&self) -> u64 {
        self.group.as_ref().map(|g| g.epoch().as_u64()).unwrap_or(0)
    }

    fn leaf_of(&self, member_id: &[u8]) -> Result<LeafNodeIndex, Error> {
        let g = self.group()?;
        g.members()
            .find(|m| m.credential.serialized_content() == member_id)
            .map(|m| m.index)
            .ok_or(Error::NotMember)
    }

    /// Vor jedem Commit (eigen oder fremd): Zustand der verlassenen Epoche sichern, für den Tiebreak.
    fn take_snapshot(&mut self) -> Result<u64, Error> {
        let parent = self.group()?.epoch().as_u64();
        let storage = self.provider.storage().values.read().map_err(|_| Error::Mls("storage lock".into()))?.clone();
        self.snapshots.retain(|s| s.parent_epoch < parent);
        self.snapshots.push(Snapshot { parent_epoch: parent, applied_hash: [0; 32], storage, exporters: self.exporters.clone() });
        if self.snapshots.len() > SNAPSHOT_DEPTH {
            self.snapshots.remove(0);
        }
        Ok(parent)
    }

    fn mark_applied(&mut self, h: [u8; 32]) {
        if let Some(s) = self.snapshots.last_mut() {
            s.applied_hash = h;
        }
    }

    fn finish_own_commit(&mut self, commit: &[u8]) -> Result<(), Error> {
        let provider = &self.provider;
        self.group.as_mut().ok_or(Error::NoGroup)?.merge_pending_commit(provider).map_err(mls)?;
        self.remember_exporter()?;
        let h = digest(commit);
        self.own.insert(h);
        self.mark_applied(h);
        Ok(())
    }

    fn encode(op: &Op) -> Result<Vec<u8>, Error> {
        bincode::serialize(op).map_err(|e| Error::Codec(e.to_string()))
    }

    /// Ein Mitglied aufnehmen: liefert den Commit (an alle) und das Willkommen (an den Neuen).
    pub fn add(&mut self, share_key: &[u8]) -> Result<(Vec<u8>, Vec<u8>), Error> {
        self.take_snapshot()?;
        let kp_msg = MlsMessageIn::tls_deserialize_exact(share_key).map_err(|e| Error::Codec(e.to_string()))?;
        let kp = match kp_msg.extract() {
            MlsMessageBodyIn::KeyPackage(kp) => kp,
            _ => return Err(Error::Codec("kein KeyPackage".into())),
        };
        let kp = kp.validate(self.provider.crypto(), ProtocolVersion::Mls10).map_err(mls)?;
        let (provider, signer) = (&self.provider, &self.signer);
        let (commit, welcome, _) = self.group.as_mut().ok_or(Error::NoGroup)?.add_members(provider, signer, &[kp]).map_err(mls)?;
        let commit = commit.tls_serialize_detached().map_err(|e| Error::Codec(e.to_string()))?;
        let welcome = welcome.tls_serialize_detached().map_err(|e| Error::Codec(e.to_string()))?;
        self.finish_own_commit(&commit)?;
        Ok((Self::encode(&Op::Commit { bytes: commit })?, Self::encode(&Op::Welcome { bytes: welcome })?))
    }

    /// Ein Mitglied entfernen: der Commit, oder None, wenn es nicht im Baum ist.
    pub fn remove(&mut self, member_id: &[u8]) -> Result<Option<Vec<u8>>, Error> {
        let leaf = match self.leaf_of(member_id) {
            Ok(l) => l,
            Err(Error::NotMember) => return Ok(None),
            Err(e) => return Err(e),
        };
        self.take_snapshot()?;
        let (provider, signer) = (&self.provider, &self.signer);
        let (commit, _, _) = self.group.as_mut().ok_or(Error::NoGroup)?.remove_members(provider, signer, &[leaf]).map_err(mls)?;
        let commit = commit.tls_serialize_detached().map_err(|e| Error::Codec(e.to_string()))?;
        self.finish_own_commit(&commit)?;
        Ok(Some(Self::encode(&Op::Commit { bytes: commit })?))
    }

    /// Rotation auf Verlangen (KV5): eigener Update-Commit.
    pub fn rotate(&mut self) -> Result<Vec<u8>, Error> {
        self.take_snapshot()?;
        let (provider, signer) = (&self.provider, &self.signer);
        let bundle = self.group.as_mut().ok_or(Error::NoGroup)?.self_update(provider, signer, LeafNodeParameters::default()).map_err(mls)?;
        let commit = bundle.commit().tls_serialize_detached().map_err(|e| Error::Codec(e.to_string()))?;
        self.finish_own_commit(&commit)?;
        Self::encode(&Op::Commit { bytes: commit })
    }

    /// Ganzer Stand (Speicher, Exporter, Momentaufnahmen) für eine probeweise Anwendung.
    fn checkpoint(&self) -> Result<Checkpoint, Error> {
        let storage = self.provider.storage().values.read().map_err(|_| Error::Mls("storage lock".into()))?.clone();
        Ok(Checkpoint { storage, exporters: self.exporters.clone(), snapshots: self.snapshots.clone() })
    }

    fn restore_checkpoint(&mut self, c: Checkpoint) -> Result<(), Error> {
        *self.provider.storage().values.write().map_err(|_| Error::Mls("storage lock".into()))? = c.storage;
        self.exporters = c.exporters;
        self.snapshots = c.snapshots;
        let gid = self.group()?.group_id().clone();
        self.group = MlsGroup::load(self.provider.storage(), &gid).map_err(mls)?;
        self.group()?;
        Ok(())
    }

    /// Auf die Momentaufnahme der Epoche `parent` zurückfallen; alles danach verfällt.
    fn restore_snapshot(&mut self, parent: u64) -> Result<(), Error> {
        let i = self.snapshots.iter().position(|s| s.parent_epoch == parent).ok_or(Error::NoGroup)?;
        let s = self.snapshots.remove(i);
        self.snapshots.truncate(i);
        *self.provider.storage().values.write().map_err(|_| Error::Mls("storage lock".into()))? = s.storage;
        self.exporters = s.exporters;
        let gid = self.group()?.group_id().clone();
        self.group = MlsGroup::load(self.provider.storage(), &gid).map_err(mls)?;
        self.group()?;
        Ok(())
    }

    /// Eine Operation von der Leitung einspielen. Fehler, wenn sie nicht passt (Vorgänger fehlen): der Aufrufer puffert.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<(), Error> {
        let op: Op = bincode::deserialize(bytes).map_err(|e| Error::Codec(e.to_string()))?;
        match op {
            Op::Welcome { bytes } => match self.welcome(&bytes)? {
                Welcomed::Joined => Ok(()),
                Welcomed::Reset => Err(Error::Reset),
            },
            Op::Commit { bytes } => {
                let h = digest(&bytes);
                if self.own.contains(&h) {
                    return Err(Error::Own);
                }
                let msg = MlsMessageIn::tls_deserialize_exact(&bytes).map_err(|e| Error::Codec(e.to_string()))?;
                let proto: ProtocolMessage = msg.try_into_protocol_message().map_err(mls)?;
                let incoming_epoch = proto.epoch().as_u64();
                let g = self.group()?;
                let current = g.epoch().as_u64();
                // Entfernt (Gruppe inaktiv): Commits ab der aktuellen Epoche warten wie ohne Gruppe, bis ein Willkommen
                // wieder aufnimmt; der Aufrufer puffert. (Der Commit, der uns aufgenommen hat, ist für MLS nicht mehr
                // verarbeitbar; der Kandidat kennt ihn über das Willkommen, hier ist er `Stale`.) Commits auf eine
                // verlassene Epoche nehmen weiter am Tiebreak teil: die Entfernung kann auf dem Verliererzweig stehen.
                if incoming_epoch >= current && !g.is_active() {
                    return Err(Error::NoGroup);
                }
                if incoming_epoch > current {
                    return Err(Error::Epoch(format!("Epoche {incoming_epoch}, hier {current}")));
                }
                if incoming_epoch < current {
                    // Commit auf eine verlassene Epoche (Vertrag Punkt 2). Erst die Frage, ob er überhaupt auf dem
                    // Zustand dieser Epoche aufsetzt (dieselbe Nummer heißt nicht derselbe Vorgänger), dann der Hash:
                    // nur unter echten Geschwistern entscheidet der kleinere.
                    let Some(s) = self.snapshots.iter().find(|s| s.parent_epoch == incoming_epoch) else {
                        return Err(Error::Stale(format!("Epoche {incoming_epoch}, hier {current}, keine Momentaufnahme")));
                    };
                    let applied = s.applied_hash;
                    if h == applied {
                        return Err(Error::Own);
                    }
                    let checkpoint = self.checkpoint()?;
                    self.restore_snapshot(incoming_epoch)?;
                    self.take_snapshot()?;
                    if let Err(e) = self.apply_commit(proto) {
                        // Anderer Zweig: anwendbar erst, wenn sein Vorgänger den Tiebreak gegen unseren gewinnt. Bis
                        // dahin wartet er beim Aufrufer; er verfällt, wenn seine Epoche aus den Momentaufnahmen fällt.
                        self.restore_checkpoint(checkpoint)?;
                        return Err(Error::Epoch(format!("Epoche {incoming_epoch}, anderer Zweig, Vorgänger offen: {e}")));
                    }
                    if h >= applied {
                        self.restore_checkpoint(checkpoint)?;
                        return Err(Error::Stale(format!("Geschwister verliert den Tiebreak auf Epoche {incoming_epoch}")));
                    }
                    self.mark_applied(h);
                    return Err(Error::LostTiebreak);
                }
                self.take_snapshot()?;
                if let Err(e) = self.apply_commit(proto) {
                    // Anderer Zweig auf der aktuellen Epoche: anwendbar erst, wenn sein Vorgänger den Tiebreak gegen
                    // unseren gewinnt (Rückfall, dann passt er). Bis dahin wartet er beim Aufrufer.
                    self.snapshots.pop();
                    self.group = MlsGroup::load(self.provider.storage(), &self.group()?.group_id().clone()).map_err(mls)?;
                    return Err(Error::Epoch(format!("Epoche {incoming_epoch}, anderer Zweig, Vorgänger offen: {e}")));
                }
                self.mark_applied(h);
                Ok(())
            }
        }
    }

    fn apply_commit(&mut self, proto: ProtocolMessage) -> Result<(), Error> {
        let provider = &self.provider;
        let group = self.group.as_mut().ok_or(Error::NoGroup)?;
        let processed = group.process_message(provider, proto).map_err(mls)?;
        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                let removed = staged.self_removed();
                group.merge_staged_commit(provider, *staged).map_err(mls)?;
                if !removed {
                    self.remember_exporter()?;
                }
                Ok(())
            }
            _ => Err(Error::Mls("kein Commit".into())),
        }
    }

    pub fn members(&self) -> Vec<Vec<u8>> {
        match self.group.as_ref() {
            Some(g) if g.is_active() => g.members().map(|m| m.credential.serialized_content().to_vec()).collect(),
            _ => Vec::new(),
        }
    }

    pub fn has_key(&self) -> bool {
        match self.group.as_ref() {
            Some(g) => g.is_active() && self.exporters.contains_key(&g.epoch().as_u64()),
            None => false,
        }
    }

    fn entry_key(exporter: &[u8; 32], content_ref: &[u8]) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"rltp-entry-key");
        h.update(exporter);
        h.update(content_ref);
        h.finalize().into()
    }

    /// Eintrag versiegeln: Schlüssel aus dem Exporter der aktuellen Epoche und der Referenz.
    pub fn encrypt(&self, content_ref: &[u8], plaintext: &[u8]) -> Result<Sealed2, Error> {
        let g = self.group()?;
        if !g.is_active() {
            return Err(Error::NoGroup);
        }
        let epoch = g.epoch().as_u64();
        let exporter = self.exporters.get(&epoch).ok_or(Error::NoGroup)?;
        let key = Self::entry_key(exporter, content_ref);
        let mut nonce = [0u8; 12];
        {
            use openmls_traits::random::OpenMlsRand;
            nonce.copy_from_slice(&self.provider.rand().random_vec(12).map_err(mls)?);
        }
        let ciphertext = aes_gcm_seal(&key, &nonce, plaintext)?;
        let sealed = Sealed { epoch, content_ref: content_ref.to_vec(), nonce, ciphertext };
        Ok(Sealed2 { ciphertext: bincode::serialize(&sealed).map_err(|e| Error::Codec(e.to_string()))?, app_key: key })
    }

    pub fn decrypt(&self, bytes: &[u8]) -> Result<(Vec<u8>, [u8; 32]), Error> {
        let sealed: Sealed = bincode::deserialize(bytes).map_err(|e| Error::Codec(e.to_string()))?;
        let exporter = self.exporters.get(&sealed.epoch).ok_or(Error::Decrypt)?;
        let key = Self::entry_key(exporter, &sealed.content_ref);
        let plain = aes_gcm_open(&key, &sealed.nonce, &sealed.ciphertext).map_err(|_| Error::Decrypt)?;
        Ok((plain, key))
    }

    pub fn decrypt_with_key(bytes: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, Error> {
        let sealed: Sealed = bincode::deserialize(bytes).map_err(|e| Error::Codec(e.to_string()))?;
        aes_gcm_open(key, &sealed.nonce, &sealed.ciphertext).map_err(|_| Error::Decrypt)
    }

    /// Zustand exportieren (S7: Diebstahl): Speicher, Signierschlüssel, Identität, Exporter.
    pub fn export_state(&self) -> Result<Vec<u8>, Error> {
        let storage = self.provider.storage().values.read().map_err(|_| Error::Mls("storage lock".into()))?.clone();
        let state = State {
            storage,
            signer: bincode::serialize(&self.signer).map_err(|e| Error::Codec(e.to_string()))?,
            identity: self.identity.clone(),
            key_package: self.key_package.clone(),
            group_id: self.group.as_ref().map(|g| g.group_id().to_vec()),
            exporters: self.exporters.iter().map(|(k, v)| (*k, v.to_vec())).collect(),
        };
        bincode::serialize(&state).map_err(|e| Error::Codec(e.to_string()))
    }

    pub fn from_state(bytes: &[u8]) -> Result<Self, Error> {
        let state: State = bincode::deserialize(bytes).map_err(|e| Error::Codec(e.to_string()))?;
        let provider = OpenMlsRustCrypto::default();
        *provider.storage().values.write().map_err(|_| Error::Mls("storage lock".into()))? = state.storage;
        let signer: SignatureKeyPair = bincode::deserialize(&state.signer).map_err(|e| Error::Codec(e.to_string()))?;
        let credential: Credential = BasicCredential::new(state.identity.clone()).into();
        let credential = CredentialWithKey { credential, signature_key: signer.to_public_vec().into() };
        let group = match state.group_id {
            Some(gid) => MlsGroup::load(provider.storage(), &GroupId::from_slice(&gid)).map_err(mls)?,
            None => None,
        };
        let exporters = state
            .exporters
            .into_iter()
            .map(|(k, v)| {
                let mut a = [0u8; 32];
                a.copy_from_slice(&v);
                (k, a)
            })
            .collect();
        Ok(Peer { provider, signer, identity: state.identity, credential, key_package: state.key_package, bundle: None, group, exporters, own: Default::default(), snapshots: Vec::new() })
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct State {
    storage: HashMap<Vec<u8>, Vec<u8>>,
    signer: Vec<u8>,
    identity: Vec<u8>,
    key_package: Vec<u8>,
    group_id: Option<Vec<u8>>,
    exporters: Vec<(u64, Vec<u8>)>,
}

fn aes_gcm_seal(key: &[u8; 32], nonce: &[u8; 12], plaintext: &[u8]) -> Result<Vec<u8>, Error> {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| Error::Mls(e.to_string()))?;
    cipher.encrypt(Nonce::from_slice(nonce), plaintext).map_err(|_| Error::Decrypt)
}

fn aes_gcm_open(key: &[u8; 32], nonce: &[u8; 12], ciphertext: &[u8]) -> Result<Vec<u8>, Error> {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| Error::Mls(e.to_string()))?;
    cipher.decrypt(Nonce::from_slice(nonce), ciphertext).map_err(|_| Error::Decrypt)
}
