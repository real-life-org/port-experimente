// Ein Peer = ein Gerät: p2panda-spaces Manager über einem Speicher im
// Arbeitsspeicher, dazu ein Puffer für kausale Ordnung.
//
// p2panda-spaces erwartet Nachrichten „signature-checked, dependency-checked &
// partially ordered“ (Manager::process). Genau das leistet hier der Puffer:
// Signatur prüfen, ablegen, zurückhalten bis alle Abhängigkeiten verarbeitet
// sind. Im vollen p2panda-Stack übernimmt das p2panda-stream.

use std::borrow::Borrow;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex};

use p2panda_auth::Access;
use p2panda_core::cbor::{decode_cbor, encode_cbor};

use p2panda_core::traits::{Digest, Provenance};
use p2panda_core::{Hash, Header, Operation, SigningKey, VerifyingKey};
use p2panda_encryption::Rng;
use p2panda_encryption::key_manager::PreKeyBundlesState;
use p2panda_encryption::key_registry::KeyRegistryState;
use p2panda_spaces::manager::Manager;
use p2panda_spaces::{
    ActorId, AuthMessage, Config, Credentials, Event, Forge, SpaceId, SpacesArgs,
    SpacesStoreState, StrongRemoveResolver,
};
use p2panda_spaces::space::SpacesState;
use p2panda_store::Transaction;
use p2panda_auth::group::GroupCrdtState;
use p2panda_store::groups::GroupsStore;
use p2panda_store::key_registry::KeyRegistryStore;
use p2panda_store::key_secrets::KeySecretsStore;
use p2panda_store::spaces::{SpacesMessage, SpacesMessageStore, SpacesStore};

pub type Cond = ();
pub type Args = SpacesArgs<Cond>;
type GroupsState = GroupCrdtState<VerifyingKey, Hash, AuthMessage<Cond>, Cond>;

/// Wie p2panda-spaces (manager.rs, nicht exportiert): Kontext des globalen Gruppenzustands.
const GLOBAL_GROUPS_CONTEXT_ID: &[u8] = b"global-groups-context";

// ── Nachricht ────────────────────────────────────────────────────────────

/// Eine p2panda-Operation mit Spaces-Argumenten. Newtype, weil Borrow für
/// fremde Typen nicht implementiert werden kann.
#[derive(Clone, Debug)]
pub struct Msg(pub Operation<Args>);

impl Digest<Hash> for Msg {
    fn hash(&self) -> Hash {
        self.0.hash
    }
}
impl Provenance<VerifyingKey> for Msg {
    fn author(&self) -> VerifyingKey {
        self.0.header.verifying_key
    }
    fn verify(&self) -> bool {
        self.0.header.verify()
    }
}
impl Borrow<Args> for Msg {
    fn borrow(&self) -> &Args {
        &self.0.header.extensions
    }
}

impl Msg {
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        Ok(self.0.header.encode())
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let header: Header<Args> = Header::decode(bytes).map_err(Error::from_display)?;
        if !header.verify() {
            return Err(Error("Signatur ungültig".into()));
        }
        Ok(Msg(Operation::from_parts(header, None)))
    }
    /// Operationen, die vor dieser verarbeitet sein müssen.
    fn dependencies(&self) -> Vec<Hash> {
        match &self.0.header.extensions {
            SpacesArgs::KeyBundle { .. } => vec![],
            SpacesArgs::Auth { auth_dependencies, .. } => auth_dependencies.clone(),
            SpacesArgs::SpaceMembership { space_dependencies, auth_message_id, .. } => {
                let mut d = space_dependencies.clone();
                d.push(*auth_message_id);
                d
            }
            SpacesArgs::SpaceUpdate { space_dependencies, .. } => space_dependencies.clone(),
            SpacesArgs::Application { space_dependencies, .. } => space_dependencies.clone(),
        }
    }
}

// ── Fehler ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Error(pub String);
impl Error {
    fn from_display(e: impl fmt::Display) -> Self {
        Error(e.to_string())
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}

// ── Speicher im Arbeitsspeicher ──────────────────────────────────────────

#[derive(Default)]
struct Inner {
    operations: HashMap<Hash, Operation<Args>>,
    spaces: HashMap<Hash, Vec<u8>>,
    groups: HashMap<Hash, Vec<u8>>,
    key_registry: Option<Vec<u8>>,
    prekeys: Option<Vec<u8>>,
    /// Letzte eigene Operation je Autor (für seq_num und backlink).
    latest: HashMap<VerifyingKey, (u32, Hash)>,
}

/// Erfüllt die Speicher-Traits von p2panda-store; Zustand wird wie im
/// SQLite-Speicher serialisiert abgelegt (CBOR).
#[derive(Clone, Default)]
pub struct MemStore(Arc<Mutex<Inner>>);

impl MemStore {
    fn with<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        f(&mut self.0.lock().expect("Speicher vergiftet"))
    }
    pub fn insert_operation(&self, op: &Operation<Args>) {
        self.with(|s| {
            s.operations.insert(op.hash, op.clone());
        })
    }
    pub fn has_operation(&self, id: &Hash) -> bool {
        self.with(|s| s.operations.contains_key(id))
    }
}

fn enc<T: serde::Serialize>(v: &T) -> Result<Vec<u8>, Error> {
    encode_cbor(v).map_err(Error::from_display)
}
fn dec<T: for<'a> serde::Deserialize<'a>>(b: &[u8]) -> Result<T, Error> {
    decode_cbor(b).map_err(Error::from_display)
}

impl Transaction for MemStore {
    type Error = Error;
    type Permit = ();
    async fn begin(&self) -> Result<(), Error> {
        Ok(())
    }
    async fn rollback(&self, _: ()) -> Result<(), Error> {
        Ok(())
    }
    async fn commit(&self, _: ()) -> Result<(), Error> {
        Ok(())
    }
}

impl SpacesMessageStore<Args> for MemStore {
    type Error = Error;
    async fn get_spaces_message(&self, id: &Hash) -> Result<Option<SpacesMessage<Args>>, Error> {
        Ok(self.with(|s| {
            s.operations.get(id).map(|op| SpacesMessage {
                id: op.hash,
                author: op.header.verifying_key,
                args: op.header.extensions.clone(),
            })
        }))
    }
}

impl<S> SpacesStore<S> for MemStore
where
    S: for<'a> serde::Deserialize<'a> + serde::Serialize,
{
    type Error = Error;
    async fn get_space_state_tx(&self, id: &Hash) -> Result<Option<S>, Error> {
        self.with(|s| s.spaces.get(id).cloned()).map(|b| dec(&b)).transpose()
    }
    async fn set_space_state_tx(&self, id: &Hash, y: &S) -> Result<(), Error> {
        let b = enc(y)?;
        self.with(|s| s.spaces.insert(*id, b));
        Ok(())
    }
    async fn has_space(&self, id: &Hash) -> Result<bool, Error> {
        Ok(self.with(|s| s.spaces.contains_key(id)))
    }
    async fn space_ids(&self) -> Result<Vec<Hash>, Error> {
        Ok(self.with(|s| s.spaces.keys().copied().collect()))
    }
}

impl GroupsStore<AuthMessage<Cond>, Cond> for MemStore {
    type Error = Error;
    async fn set_groups_state_tx(
        &self,
        id: Hash,
        state: &GroupsState,
    ) -> Result<(), Error> {
        let b = enc(state)?;
        self.with(|s| s.groups.insert(id, b));
        Ok(())
    }
    async fn get_groups_state_tx(
        &self,
        id: Hash,
    ) -> Result<Option<GroupsState>, Error> {
        self.with(|s| s.groups.get(&id).cloned()).map(|b| dec(&b)).transpose()
    }
}

impl KeyRegistryStore for MemStore {
    type Error = Error;
    async fn get_key_registry(&self) -> Result<Option<KeyRegistryState<VerifyingKey>>, Error> {
        self.with(|s| s.key_registry.clone()).map(|b| dec(&b)).transpose()
    }
    async fn set_key_registry(&self, state: &KeyRegistryState<VerifyingKey>) -> Result<(), Error> {
        let b = enc(state)?;
        self.with(|s| s.key_registry = Some(b));
        Ok(())
    }
}

impl KeySecretsStore for MemStore {
    type Error = Error;
    async fn get_prekey_secrets(&self) -> Result<Option<PreKeyBundlesState>, Error> {
        self.with(|s| s.prekeys.clone()).map(|b| dec(&b)).transpose()
    }
    async fn set_prekey_secrets(&self, state: &PreKeyBundlesState) -> Result<(), Error> {
        let b = enc(state)?;
        self.with(|s| s.prekeys = Some(b));
        Ok(())
    }
}

// ── Forge: signiert eigene Operationen und legt sie ab ───────────────────

#[derive(Clone)]
pub struct MemForge {
    signing_key: SigningKey,
    store: MemStore,
}

impl Forge<Cond> for MemForge {
    type Message = Msg;
    type Error = Error;
    fn verifying_key(&self) -> VerifyingKey {
        self.signing_key.verifying_key()
    }
    async fn forge(&self, args: Args) -> Result<Msg, Error> {
        let me = self.signing_key.verifying_key();
        let (seq_num, backlink) = self
            .store
            .with(|s| s.latest.get(&me).copied())
            .map(|(seq, hash)| (seq + 1, Some(hash)))
            .unwrap_or((0, None));
        let header = Header::builder()
            .seq_num(seq_num)
            .backlink(backlink)
            .build(&self.signing_key, args);
        let op = Operation::from_parts(header, None);
        self.store.with(|s| {
            s.latest.insert(me, (seq_num, op.hash));
            s.operations.insert(op.hash, op.clone());
        });
        Ok(Msg(op))
    }
}

// ── Peer ─────────────────────────────────────────────────────────────────

pub type SpacesManager = Manager<MemStore, MemForge, Cond, StrongRemoveResolver<Cond>>;

/// Was ein Peer nach der Verarbeitung einer Nachricht meldet.
#[derive(Debug, Default)]
pub struct Processed {
    /// Entschlüsselte Anwendungsdaten.
    pub application: Vec<Vec<u8>>,
    /// Nachrichten, die (noch) auf Abhängigkeiten warten.
    pub pending: usize,
    /// Fehler einzelner Nachrichten (nicht abbrechen, aber melden).
    pub errors: Vec<String>,
}

pub struct Peer {
    pub manager: SpacesManager,
    store: MemStore,
    /// Bereits verarbeitete Operationen (eigene gelten als verarbeitet).
    processed: HashSet<Hash>,
    /// Zurückgehaltene Nachrichten, deren Abhängigkeiten fehlen.
    pending: Vec<Msg>,
}

pub fn access(role: &str) -> Access<Cond> {
    match role {
        "manage" | "admin" => Access::manage(),
        "read" => Access::read(),
        _ => Access::write(),
    }
}

impl Peer {
    pub fn new() -> Result<Self, Error> {
        let rng = Rng::default();
        let credentials = Credentials::from_rng(&rng).map_err(Error::from_display)?;
        let store = MemStore::default();
        let forge = MemForge { signing_key: credentials.signing_key(), store: store.clone() };
        let manager = SpacesManager::new_with_config(store.clone(), forge, credentials, &Config::default(), rng)
            .map_err(Error::from_display)?;
        Ok(Peer { manager, store, processed: HashSet::new(), pending: Vec::new() })
    }

    pub fn id(&self) -> ActorId {
        self.manager.id()
    }

    fn own(&mut self, msgs: impl IntoIterator<Item = Msg>) -> Result<Vec<Vec<u8>>, Error> {
        msgs.into_iter()
            .map(|m| {
                self.processed.insert(m.hash());
                m.encode()
            })
            .collect()
    }

    pub async fn key_bundle(&mut self) -> Result<Vec<u8>, Error> {
        let m = self.manager.key_bundle_message().await.map_err(Error::from_display)?;
        Ok(self.own([m])?.remove(0))
    }

    /// Speichert, was p2panda-spaces zurückgibt (die App hält die Transaktionsgrenze).
    async fn persist(&self, groups: Option<&GroupsState>, space: Option<SpacesState<Cond>>) -> Result<(), Error> {
        if let Some(y) = groups {
            self.store.set_groups_state_tx(Hash::digest(GLOBAL_GROUPS_CONTEXT_ID), y).await?;
        }
        if let Some(y) = space {
            let id = y.space_id;
            let stored: SpacesStoreState<Cond> = y.into();
            self.store.set_space_state_tx(&id, &stored).await?;
        }
        Ok(())
    }

    pub async fn create_space(&mut self, space_id: SpaceId) -> Result<Vec<Vec<u8>>, Error> {
        let (groups_y, space_y, msgs) = self
            .manager
            .create_space(space_id, &[])
            .await
            .map_err(Error::from_display)?;
        self.persist(Some(&groups_y), Some(space_y)).await?;
        self.own(msgs)
    }

    async fn space(&self, space_id: SpaceId) -> Result<p2panda_spaces::space::Space<MemStore, MemForge, Cond, StrongRemoveResolver<Cond>>, Error> {
        self.manager
            .space(space_id)
            .await
            .map_err(Error::from_display)?
            .ok_or_else(|| Error("Space unbekannt".into()))
    }

    pub async fn add(&mut self, space_id: SpaceId, member: ActorId, role: &str) -> Result<Vec<Vec<u8>>, Error> {
        let space = self.space(space_id).await?;
        let (groups_y, space_y, a, b) = space.add(member, access(role)).await.map_err(Error::from_display)?;
        self.persist(Some(&groups_y), Some(space_y)).await?;
        self.own([a, b])
    }

    pub async fn remove(&mut self, space_id: SpaceId, member: ActorId) -> Result<Vec<Vec<u8>>, Error> {
        let space = self.space(space_id).await?;
        let (groups_y, space_y, a, b) = space.remove(member).await.map_err(Error::from_display)?;
        self.persist(Some(&groups_y), Some(space_y)).await?;
        self.own([a, b])
    }

    pub async fn publish(&mut self, space_id: SpaceId, data: &[u8]) -> Result<Vec<u8>, Error> {
        let space = self.space(space_id).await?;
        let (space_y, m) = space.publish(data).await.map_err(Error::from_display)?;
        self.persist(None, Some(space_y)).await?;
        Ok(self.own([m])?.remove(0))
    }

    pub async fn members(&self, space_id: SpaceId) -> Result<Vec<(ActorId, String)>, Error> {
        let Ok(space) = self.space(space_id).await else { return Ok(vec![]) };
        let members = space.members().await.map_err(Error::from_display)?;
        Ok(members.into_iter().map(|(id, a)| (id, format!("{a:?}"))).collect())
    }

    /// Nimmt eine fremde Nachricht an: prüfen, ablegen, kausal geordnet verarbeiten.
    pub async fn receive(&mut self, bytes: &[u8]) -> Result<Processed, Error> {
        let msg = Msg::decode(bytes)?;
        let mut out = Processed::default();
        if self.processed.contains(&msg.hash()) || self.pending.iter().any(|m| m.hash() == msg.hash()) {
            out.pending = self.pending.len();
            return Ok(out);
        }
        self.store.insert_operation(&msg.0);
        self.pending.push(msg);
        // So lange verarbeiten, bis nichts mehr freigegeben wird.
        loop {
            let ready = self
                .pending
                .iter()
                .position(|m| m.dependencies().iter().all(|d| self.processed.contains(d)));
            let Some(i) = ready else { break };
            let m = self.pending.remove(i);
            self.processed.insert(m.hash());
            match self.manager.process(&m).await {
                Ok((groups_y, space_y, events)) => {
                    self.persist(groups_y.as_ref(), space_y).await?;
                    for e in events {
                        if let Event::Application { data, .. } = e {
                            out.application.push(data);
                        }
                    }
                }
                Err(e) => out.errors.push(e.to_string()),
            }
        }
        out.pending = self.pending.len();
        Ok(out)
    }

    /// Repariert alle Spaces, die laut p2panda nicht zum globalen Gruppenzustand passen.
    pub async fn repair(&mut self) -> Result<(usize, Vec<Vec<u8>>), Error> {
        let ids = self.manager.spaces_repair_required().await.map_err(Error::from_display)?;
        if ids.is_empty() {
            return Ok((0, vec![]));
        }
        let results = self.manager.repair_spaces(&ids).await.map_err(Error::from_display)?;
        let mut out = vec![];
        for (space_y, msgs) in results {
            self.persist(None, Some(space_y)).await?;
            out.extend(self.own(msgs)?);
        }
        Ok((ids.len(), out))
    }

    pub fn has_operation(&self, id: &Hash) -> bool {
        self.store.has_operation(id)
    }
}
