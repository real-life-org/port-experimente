// Ein Peer = ein Gerät mit einem BeeKEM-Zustand je Gruppe.
//
// BeeKEM prüft keine Autorität: Jeder Signer darf Mitglieder hinzufügen oder
// entfernen. Wer darf, entscheidet die App (bei uns das Autoritätslog nach der
// Konfliktmatrix). BeeKEM erwartet kausal geordnete Operationen; der Peer
// puffert, was noch Vorgänger vermisst.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use beekem::cgka::Cgka;
use beekem::encrypted::EncryptedContent;
use beekem::error::CgkaError;
use beekem::id::{MemberId, TreeId};
use beekem::keys::ShareKeyMap;
use beekem::operation::CgkaOperation;
use future_form::Local;
use keyhive_crypto::digest::Digest;
use keyhive_crypto::share_key::{ShareKey, ShareSecretKey};
use keyhive_crypto::signed::Signed;
use keyhive_crypto::signer::memory::MemorySigner;
use keyhive_crypto::symmetric_key::SymmetricKey;
use keyhive_crypto::verifiable::Verifiable;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};

/// Inhaltsreferenz: 32 Bytes, bei uns der Hash des Yjs-Updates.
pub type ContentRef = [u8; 32];
type Encrypted = EncryptedContent<(), ContentRef>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("BeeKEM: {0}")]
    Cgka(#[from] CgkaError),
    #[error("Kodierung: {0}")]
    Codec(#[from] bincode::Error),
    #[error("Signatur ungültig")]
    Signature,
    #[error("keine Gruppe")]
    NoGroup,
    #[error("Entschlüsselung fehlgeschlagen")]
    Decrypt,
    #[error("{0}")]
    Other(String),
}

/// Was ein Peer nach dem Empfang einer Operation meldet.
#[derive(Debug, Default)]
pub struct Received {
    pub applied: bool,
    pub pending: usize,
}

/// Ergebnis einer Verschlüsselung: Chiffrat, ggf. eine BeeKEM-Operation, die
/// mitgesendet werden muss (Rotation, weil kein Schlüssel vorlag), und der
/// Anwendungsschlüssel dieses Eintrags (für die Vorgänger-Kette der App).
#[derive(Debug)]
pub struct Sealed {
    pub ciphertext: Vec<u8>,
    pub update_op: Option<Vec<u8>>,
    pub app_key: [u8; 32],
}

/// Geheimer Gerätezustand, für den Diebstahl in S7 und zum Wiederherstellen.
#[derive(Serialize, Deserialize)]
pub struct State {
    signing_key: [u8; 32],
    share_secret: ShareSecretKey,
    cgka: Option<Cgka>,
}

pub struct Peer {
    signer: MemorySigner,
    share_secret: ShareSecretKey,
    cgka: Option<Cgka>,
    seen: HashSet<Digest<Signed<CgkaOperation>>>,
    pending: VecDeque<Arc<Signed<CgkaOperation>>>,
}

fn decode_op(bytes: &[u8]) -> Result<Arc<Signed<CgkaOperation>>, Error> {
    let op: Signed<CgkaOperation> = bincode::deserialize(bytes)?;
    op.try_verify().map_err(|_| Error::Signature)?;
    Ok(Arc::new(op))
}

impl Peer {
    pub fn new() -> Self {
        let mut rng = OsRng;
        Self::from_parts(MemorySigner::generate(&mut rng), ShareSecretKey::generate(&mut rng), None)
    }

    fn from_parts(signer: MemorySigner, share_secret: ShareSecretKey, cgka: Option<Cgka>) -> Self {
        Peer { signer, share_secret, cgka, seen: HashSet::new(), pending: VecDeque::new() }
    }

    /// Mitglieds-ID = Ed25519-Verifying-Key des Signers.
    pub fn id(&self) -> MemberId {
        MemberId(self.signer.verifying_key())
    }

    /// Öffentlicher Share-Key (X25519); andere brauchen ihn, um uns aufzunehmen.
    pub fn share_key(&self) -> ShareKey {
        self.share_secret.share_key()
    }

    fn own_sks(&self) -> ShareKeyMap {
        let mut m = ShareKeyMap::new();
        m.insert(self.share_key(), self.share_secret);
        m
    }

    fn cgka(&mut self) -> Result<&mut Cgka, Error> {
        self.cgka.as_mut().ok_or(Error::NoGroup)
    }

    fn encode_own(&mut self, op: Signed<CgkaOperation>) -> Result<Vec<u8>, Error> {
        self.seen.insert(Digest::hash(&op));
        Ok(bincode::serialize(&op)?)
    }

    /// Gruppe gründen: BeeKEM anlegen, sich selbst als erstes Blatt eintragen,
    /// einen ersten Schlüssel ableiten. Liefert die Operationen zum Verteilen.
    pub async fn create(&mut self, group: TreeId) -> Result<Vec<Vec<u8>>, Error> {
        let mut cgka = Cgka::new(group, self.id(), self.own_sks());
        let add = cgka.add::<Local, _>(self.id(), self.share_key(), &self.signer).await?.ok_or_else(|| Error::Other("erstes Blatt".into()))?;
        let sk = ShareSecretKey::generate(&mut OsRng);
        let (_pcs, update, _) = cgka.update::<Local, _, _>(sk.share_key(), sk, &self.signer, &mut OsRng).await?;
        self.cgka = Some(cgka);
        Ok(vec![self.encode_own(add)?, self.encode_own(update)?])
    }

    /// Einer bestehenden Gruppe beitreten: leeres BeeKEM, die Operationen
    /// kommen über `receive` (das eigene Blatt mit der Aufnahme).
    pub fn join(&mut self, group: TreeId) {
        self.cgka = Some(Cgka::new(group, self.id(), self.own_sks()));
    }

    pub async fn add(&mut self, member: MemberId, pk: ShareKey) -> Result<Option<Vec<u8>>, Error> {
        let signer = self.signer.clone();
        let op = self.cgka()?.add::<Local, _>(member, pk, &signer).await?;
        op.map(|o| self.encode_own(o)).transpose()
    }

    pub async fn remove(&mut self, member: MemberId) -> Result<Option<Vec<u8>>, Error> {
        let signer = self.signer.clone();
        let op = self.cgka()?.remove::<Local, _>(member, &signer).await?;
        op.map(|o| self.encode_own(o)).transpose()
    }

    /// Rotation auf Verlangen (KV5): neues Blattschlüsselpaar, neuer Wurzelschlüssel.
    pub async fn rotate(&mut self) -> Result<Vec<u8>, Error> {
        let signer = self.signer.clone();
        let sk = ShareSecretKey::generate(&mut OsRng);
        let (_pcs, op, _) = self.cgka()?.update::<Local, _, _>(sk.share_key(), sk, &signer, &mut OsRng).await?;
        self.share_secret = sk;
        self.encode_own(op)
    }

    /// Fremde Operation aufnehmen; kausal puffern, was Vorgänger vermisst.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<Received, Error> {
        let op = decode_op(bytes)?;
        let digest = Digest::hash(&*op);
        let mut out = Received::default();
        if self.seen.contains(&digest) || self.pending.iter().any(|p| Digest::hash(&**p) == digest) {
            out.pending = self.pending.len();
            return Ok(out);
        }
        self.pending.push_back(op);
        // Wiederholen, bis nichts mehr freigegeben wird.
        let mut progress = true;
        while progress {
            progress = false;
            for _ in 0..self.pending.len() {
                let op = self.pending.pop_front().expect("nicht leer");
                match self.cgka()?.merge_concurrent_operation(op.clone()) {
                    Ok(_) => {
                        self.seen.insert(Digest::hash(&*op));
                        out.applied = true;
                        progress = true;
                    }
                    Err(CgkaError::OutOfOrderOperation) => self.pending.push_back(op),
                    Err(e) => return Err(e.into()),
                }
            }
        }
        out.pending = self.pending.len();
        Ok(out)
    }

    pub fn members(&self) -> Vec<MemberId> {
        self.cgka.as_ref().map(|c| c.member_ids().collect()).unwrap_or_default()
    }

    pub fn has_key(&self) -> bool {
        self.cgka.as_ref().is_some_and(|c| c.has_pcs_key())
    }

    /// Inhalt verschlüsseln. Fehlt ein Schlüssel (nach gleichzeitigen
    /// Änderungen), rotiert BeeKEM und liefert die Operation mit.
    pub async fn encrypt(&mut self, content_ref: ContentRef, preds: Vec<ContentRef>, plaintext: &[u8]) -> Result<Sealed, Error> {
        let signer = self.signer.clone();
        let (secret, update, _) = self
            .cgka()?
            .new_app_secret_for::<Local, _, ContentRef, _>(&content_ref, plaintext, &preds, &signer, &mut OsRng)
            .await?;
        let enc: Encrypted = secret.try_encrypt(plaintext).map_err(|_| Error::Decrypt)?;
        let update_op = update.map(|o| self.encode_own(o)).transpose()?;
        Ok(Sealed { ciphertext: bincode::serialize(&enc)?, update_op, app_key: <[u8; 32]>::from(secret.key()) })
    }

    /// Inhalt mit dem Gruppenschlüssel entschlüsseln; liefert auch den
    /// Anwendungsschlüssel für die Vorgänger-Kette der App.
    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<(Vec<u8>, [u8; 32]), Error> {
        let enc: Encrypted = bincode::deserialize(ciphertext)?;
        let key = self.cgka()?.decryption_key_for(&enc).map_err(|_| Error::Decrypt)?;
        let plain = enc.try_decrypt(key).map_err(|_| Error::Decrypt)?;
        Ok((plain, <[u8; 32]>::from(key)))
    }

    /// Inhalt mit einem bekannten Anwendungsschlüssel öffnen (Historie über die Kette).
    pub fn decrypt_with_key(ciphertext: &[u8], key: [u8; 32]) -> Result<Vec<u8>, Error> {
        let enc: Encrypted = bincode::deserialize(ciphertext)?;
        enc.try_decrypt(SymmetricKey::from(key)).map_err(|_| Error::Decrypt)
    }

    /// Geheimer Zustand, wie ihn ein erbeutetes Gerät preisgibt.
    pub fn export_state(&self) -> Result<Vec<u8>, Error> {
        Ok(bincode::serialize(&State {
            signing_key: self.signer.0.to_bytes(),
            share_secret: self.share_secret,
            cgka: self.cgka.clone(),
        })?)
    }

    pub fn import_state(bytes: &[u8]) -> Result<Self, Error> {
        let s: State = bincode::deserialize(bytes)?;
        let signer = MemorySigner::from(ed25519_dalek_signing_key(s.signing_key));
        Ok(Self::from_parts(signer, s.share_secret, s.cgka))
    }
}

fn ed25519_dalek_signing_key(bytes: [u8; 32]) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&bytes)
}

impl Default for Peer {
    fn default() -> Self {
        Self::new()
    }
}
