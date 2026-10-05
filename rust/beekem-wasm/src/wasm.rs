// JavaScript-Schnittstelle (wasm-bindgen). Asynchrone Methoden liefern
// Promises; der Peer liegt hinter RefCell, die Futures lösen sofort auf
// (Local-Form), es gibt also keine überlappenden Zugriffe.

use std::cell::RefCell;
use std::rc::Rc;

use beekem::id::{MemberId, TreeId};
use js_sys::{Array, Object, Promise, Reflect, Uint8Array};
use keyhive_crypto::share_key::ShareKey;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

use crate::peer::{ContentRef, Error, Peer};

fn js(e: Error) -> JsValue {
    JsError::new(&e.to_string()).into()
}
fn bytes32(b: &[u8], what: &str) -> Result<[u8; 32], JsValue> {
    b.try_into().map_err(|_| JsValue::from(JsError::new(&format!("{what}: 32 Bytes erwartet"))))
}
fn member(b: &[u8]) -> Result<MemberId, JsValue> {
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&bytes32(b, "Mitglieds-ID")?).map_err(|e| JsValue::from(JsError::new(&e.to_string())))?;
    Ok(MemberId(vk))
}
fn u8a(v: &[u8]) -> JsValue {
    Uint8Array::from(v).into()
}

#[wasm_bindgen]
pub struct BeekemPeer {
    inner: Rc<RefCell<Peer>>,
}

#[wasm_bindgen]
impl BeekemPeer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> BeekemPeer {
        console_error_panic_hook::set_once();
        BeekemPeer { inner: Rc::new(RefCell::new(Peer::new())) }
    }

    /// Erbeuteten oder gespeicherten Zustand wiederherstellen.
    #[wasm_bindgen(js_name = fromState)]
    pub fn from_state(bytes: Vec<u8>) -> Result<BeekemPeer, JsError> {
        console_error_panic_hook::set_once();
        let p = Peer::import_state(&bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(BeekemPeer { inner: Rc::new(RefCell::new(p)) })
    }

    /// Mitglieds-ID (32 Bytes, Ed25519-Verifying-Key).
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> Uint8Array {
        Uint8Array::from(self.inner.borrow().id().as_slice())
    }

    /// Öffentlicher Share-Key (32 Bytes, X25519); mit der ID zusammen die „Karte“.
    #[wasm_bindgen(getter, js_name = shareKey)]
    pub fn share_key(&self) -> Uint8Array {
        Uint8Array::from(self.inner.borrow().share_key().to_bytes().as_slice())
    }

    /// Gruppen-ID: 32 Bytes eines Ed25519-Verifying-Keys (die App würfelt ihn).
    pub fn create(&self, group: Vec<u8>) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let tree = TreeId(ed25519_dalek::VerifyingKey::from_bytes(&bytes32(&group, "Gruppen-ID")?).map_err(|e| JsValue::from(JsError::new(&e.to_string())))?);
            let ops = inner.borrow_mut().create(tree).await.map_err(js)?;
            Ok(ops.iter().map(|o| u8a(o)).collect::<Array>().into())
        })
    }

    pub fn join(&self, group: Vec<u8>) -> Result<(), JsValue> {
        let tree = TreeId(ed25519_dalek::VerifyingKey::from_bytes(&bytes32(&group, "Gruppen-ID")?).map_err(|e| JsValue::from(JsError::new(&e.to_string())))?);
        self.inner.borrow_mut().join(tree);
        Ok(())
    }

    /// Liefert die Operation (Bytes) oder null, wenn BeeKEM nichts zu tun hatte.
    pub fn add(&self, member_id: Vec<u8>, share_key: Vec<u8>) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let id = member(&member_id)?;
            let pk = ShareKey::from(x25519_dalek_public(&bytes32(&share_key, "Share-Key")?));
            let op = inner.borrow_mut().add(id, pk).await.map_err(js)?;
            Ok(op.map(|o| u8a(&o)).unwrap_or(JsValue::NULL))
        })
    }

    pub fn remove(&self, member_id: Vec<u8>) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let id = member(&member_id)?;
            let op = inner.borrow_mut().remove(id).await.map_err(js)?;
            Ok(op.map(|o| u8a(&o)).unwrap_or(JsValue::NULL))
        })
    }

    pub fn rotate(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let op = inner.borrow_mut().rotate().await.map_err(js)?;
            Ok(u8a(&op))
        })
    }

    /// Liefert { applied: boolean, pending: number }.
    pub fn receive(&self, bytes: Vec<u8>) -> Result<JsValue, JsValue> {
        let r = self.inner.borrow_mut().receive(&bytes).map_err(js)?;
        let o = Object::new();
        Reflect::set(&o, &"applied".into(), &JsValue::from(r.applied))?;
        Reflect::set(&o, &"pending".into(), &JsValue::from(r.pending as u32))?;
        Ok(o.into())
    }

    /// Liefert { ciphertext: Uint8Array, updateOp: Uint8Array | null, appKey: Uint8Array }.
    pub fn encrypt(&self, content_ref: Vec<u8>, pred_refs: Array, plaintext: Vec<u8>) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let cref: ContentRef = bytes32(&content_ref, "Inhaltsreferenz")?;
            let mut preds: Vec<ContentRef> = Vec::new();
            for p in pred_refs.iter() {
                preds.push(bytes32(&Uint8Array::new(&p).to_vec(), "Vorgänger")?);
            }
            let s = inner.borrow_mut().encrypt(cref, preds, &plaintext).await.map_err(js)?;
            let o = Object::new();
            Reflect::set(&o, &"ciphertext".into(), &u8a(&s.ciphertext))?;
            Reflect::set(&o, &"updateOp".into(), &s.update_op.map(|b| u8a(&b)).unwrap_or(JsValue::NULL))?;
            Reflect::set(&o, &"appKey".into(), &u8a(&s.app_key))?;
            Ok(o.into())
        })
    }

    /// Liefert { plaintext, appKey }; wirft, wenn kein Schlüssel ableitbar ist.
    pub fn decrypt(&self, ciphertext: Vec<u8>) -> Result<JsValue, JsValue> {
        let (plain, key) = self.inner.borrow_mut().decrypt(&ciphertext).map_err(js)?;
        let o = Object::new();
        Reflect::set(&o, &"plaintext".into(), &u8a(&plain))?;
        Reflect::set(&o, &"appKey".into(), &u8a(&key))?;
        Ok(o.into())
    }

    #[wasm_bindgen(js_name = decryptWithKey)]
    pub fn decrypt_with_key(ciphertext: Vec<u8>, key: Vec<u8>) -> Result<Uint8Array, JsValue> {
        let k = bytes32(&key, "Schlüssel")?;
        Ok(Uint8Array::from(Peer::decrypt_with_key(&ciphertext, k).map_err(js)?.as_slice()))
    }

    /// IDs der Blätter im Baum (32 Bytes je Mitglied).
    pub fn members(&self) -> Array {
        self.inner.borrow().members().iter().map(|m| u8a(m.as_slice())).collect()
    }

    #[wasm_bindgen(js_name = hasKey)]
    pub fn has_key(&self) -> bool {
        self.inner.borrow().has_key()
    }

    /// Geheimer Gerätezustand (für S7).
    #[wasm_bindgen(js_name = exportState)]
    pub fn export_state(&self) -> Result<Uint8Array, JsValue> {
        Ok(Uint8Array::from(self.inner.borrow().export_state().map_err(js)?.as_slice()))
    }
}

fn x25519_dalek_public(bytes: &[u8; 32]) -> x25519_dalek::PublicKey {
    x25519_dalek::PublicKey::from(*bytes)
}
