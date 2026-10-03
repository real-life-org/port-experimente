// JavaScript-Schnittstelle (wasm-bindgen). Jede Methode liefert ein Promise;
// der Peer liegt hinter einem asynchronen Mutex, damit überlappende Aufrufe
// aus JS sich nicht ins Gehege kommen.

use std::rc::Rc;

use js_sys::{Array, Object, Promise, Reflect, Uint8Array};
use p2panda_core::{Hash, VerifyingKey};
use tokio::sync::Mutex;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

use crate::peer::{Error, Peer};

fn js(e: Error) -> JsValue {
    JsError::new(&e.0).into()
}

fn bytes_array(v: Vec<Vec<u8>>) -> Array {
    v.into_iter().map(|b| JsValue::from(Uint8Array::from(b.as_slice()))).collect()
}

fn space_id(name: &str) -> Hash {
    Hash::digest(name.as_bytes())
}

fn actor(hex_id: &str) -> Result<VerifyingKey, JsValue> {
    let bytes: [u8; 32] = hex::decode(hex_id)
        .map_err(|e| JsValue::from(JsError::new(&e.to_string())))?
        .try_into()
        .map_err(|_| JsValue::from(JsError::new("ID muss 32 Bytes haben")))?;
    VerifyingKey::from_bytes(&bytes).map_err(|e| JsError::new(&e.to_string()).into())
}

#[wasm_bindgen]
pub struct P2pPeer {
    inner: Rc<Mutex<Peer>>,
    id: String,
}

#[wasm_bindgen]
impl P2pPeer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<P2pPeer, JsError> {
        console_error_panic_hook::set_once();
        let peer = Peer::new().map_err(|e| JsError::new(&e.0))?;
        let id = hex::encode(peer.id().as_bytes());
        Ok(P2pPeer { inner: Rc::new(Mutex::new(peer)), id })
    }

    /// Öffentlicher Schlüssel (hex) = Akteurs-ID.
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    #[wasm_bindgen(js_name = keyBundle)]
    pub fn key_bundle(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let b = inner.lock().await.key_bundle().await.map_err(js)?;
            Ok(Uint8Array::from(b.as_slice()).into())
        })
    }

    #[wasm_bindgen(js_name = createSpace)]
    pub fn create_space(&self, name: String) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let m = inner.lock().await.create_space(space_id(&name)).await.map_err(js)?;
            Ok(bytes_array(m).into())
        })
    }

    /// role: "manage" | "write" | "read"
    pub fn add(&self, name: String, member: String, role: String) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let id = actor(&member)?;
            let m = inner.lock().await.add(space_id(&name), id, &role).await.map_err(js)?;
            Ok(bytes_array(m).into())
        })
    }

    pub fn remove(&self, name: String, member: String) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let id = actor(&member)?;
            let m = inner.lock().await.remove(space_id(&name), id).await.map_err(js)?;
            Ok(bytes_array(m).into())
        })
    }

    pub fn publish(&self, name: String, data: Vec<u8>) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let m = inner.lock().await.publish(space_id(&name), &data).await.map_err(js)?;
            Ok(Uint8Array::from(m.as_slice()).into())
        })
    }

    /// Liefert { application: Uint8Array[], pending: number, errors: string[] }.
    pub fn receive(&self, bytes: Vec<u8>) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let r = inner.lock().await.receive(&bytes).await.map_err(js)?;
            let o = Object::new();
            Reflect::set(&o, &"application".into(), &bytes_array(r.application))?;
            Reflect::set(&o, &"pending".into(), &JsValue::from(r.pending as u32))?;
            let errors: Array = r.errors.iter().map(|e| JsValue::from_str(e)).collect();
            Reflect::set(&o, &"errors".into(), &errors)?;
            Ok(o.into())
        })
    }

    /// Liefert [[idHex, zugriff], …].
    pub fn members(&self, name: String) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let m = inner.lock().await.members(space_id(&name)).await.map_err(js)?;
            let out: Array = m
                .into_iter()
                .map(|(id, a)| {
                    let pair = Array::new();
                    pair.push(&JsValue::from_str(&hex::encode(id.as_bytes())));
                    pair.push(&JsValue::from_str(&a));
                    JsValue::from(pair)
                })
                .collect();
            Ok(out.into())
        })
    }
}
