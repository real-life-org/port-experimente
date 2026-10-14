//! JS-Bindings: dieselbe Oberfläche wie `beekem-wasm`, synchron.

use js_sys::{Array, Object, Reflect, Uint8Array};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

use crate::peer::{Error, Peer};

fn js(e: Error) -> JsValue {
    js_sys::Error::new(&format!("MLS: {e}")).into()
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct MlsPeer {
    inner: RefCell<Peer>,
}

#[wasm_bindgen]
impl MlsPeer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<MlsPeer, JsValue> {
        Ok(MlsPeer { inner: RefCell::new(Peer::new().map_err(js)?) })
    }

    #[wasm_bindgen(js_name = fromState)]
    pub fn from_state(bytes: Vec<u8>) -> Result<MlsPeer, JsValue> {
        Ok(MlsPeer { inner: RefCell::new(Peer::from_state(&bytes).map_err(js)?) })
    }

    #[wasm_bindgen(getter)]
    pub fn id(&self) -> Uint8Array {
        Uint8Array::from(self.inner.borrow().id())
    }

    #[wasm_bindgen(getter, js_name = shareKey)]
    pub fn share_key(&self) -> Uint8Array {
        Uint8Array::from(self.inner.borrow().share_key())
    }

    /// Gründen: MLS erzeugt keine Operation für andere; leeres Array.
    pub fn create(&self, group: Vec<u8>) -> Result<Array, JsValue> {
        let ops = self.inner.borrow_mut().create(&group).map_err(js)?;
        Ok(ops.iter().map(|o| JsValue::from(Uint8Array::from(o.as_slice()))).collect())
    }

    /// Aktuelle Epoche (0 ohne Gruppe).
    pub fn epoch(&self) -> f64 {
        self.inner.borrow().epoch() as f64
    }

    /// Aufnahme: `{ op, welcome }`, op an alle, welcome an den Neuen.
    pub fn add(&self, _member_id: Vec<u8>, share_key: Vec<u8>) -> Result<JsValue, JsValue> {
        let (op, welcome) = self.inner.borrow_mut().add(&share_key).map_err(js)?;
        let out = Object::new();
        Reflect::set(&out, &"op".into(), &Uint8Array::from(op.as_slice()))?;
        Reflect::set(&out, &"welcome".into(), &Uint8Array::from(welcome.as_slice()))?;
        Ok(out.into())
    }

    pub fn remove(&self, member_id: Vec<u8>) -> Result<JsValue, JsValue> {
        Ok(match self.inner.borrow_mut().remove(&member_id).map_err(js)? {
            Some(op) => Uint8Array::from(op.as_slice()).into(),
            None => JsValue::NULL,
        })
    }

    pub fn rotate(&self) -> Result<Uint8Array, JsValue> {
        Ok(Uint8Array::from(self.inner.borrow_mut().rotate().map_err(js)?.as_slice()))
    }

    /// Operation einspielen: "ok", "own" (eigenes Echo oder schon drin), "lost" (Tiebreak verloren, fremder Commit
    /// gilt, eigener Zustand zurückgefallen), "stale" (nie mehr anwendbar) oder "reset" (Willkommen auf eine höhere
    /// Epoche hat die eigene Gruppe ersetzt). Wirft, wenn sie noch nicht passt (Vorgänger fehlen).
    pub fn receive(&self, bytes: Vec<u8>) -> Result<JsValue, JsValue> {
        match self.inner.borrow_mut().receive(&bytes) {
            Ok(()) => Ok("ok".into()),
            Err(Error::Own) => Ok("own".into()),
            Err(Error::LostTiebreak) => Ok("lost".into()),
            Err(Error::Stale(_)) => Ok("stale".into()),
            Err(Error::Reset) => Ok("reset".into()),
            Err(e) => Err(js(e)),
        }
    }

    /// `{ ciphertext, updateOp: null, appKey }` wie bei BeeKEM; MLS rotiert beim Schreiben nicht.
    pub fn encrypt(&self, content_ref: Vec<u8>, _pred_refs: Array, plaintext: Vec<u8>) -> Result<JsValue, JsValue> {
        let s = self.inner.borrow().encrypt(&content_ref, &plaintext).map_err(js)?;
        let out = Object::new();
        Reflect::set(&out, &"ciphertext".into(), &Uint8Array::from(s.ciphertext.as_slice()))?;
        Reflect::set(&out, &"updateOp".into(), &JsValue::NULL)?;
        Reflect::set(&out, &"appKey".into(), &Uint8Array::from(&s.app_key[..]))?;
        Ok(out.into())
    }

    pub fn decrypt(&self, ciphertext: Vec<u8>) -> Result<JsValue, JsValue> {
        let (plain, key) = self.inner.borrow().decrypt(&ciphertext).map_err(js)?;
        let out = Object::new();
        Reflect::set(&out, &"plaintext".into(), &Uint8Array::from(plain.as_slice()))?;
        Reflect::set(&out, &"appKey".into(), &Uint8Array::from(&key[..]))?;
        Ok(out.into())
    }

    #[wasm_bindgen(js_name = decryptWithKey)]
    pub fn decrypt_with_key(ciphertext: Vec<u8>, key: Vec<u8>) -> Result<Uint8Array, JsValue> {
        let mut k = [0u8; 32];
        if key.len() != 32 {
            return Err(js_sys::Error::new("MLS: Schlüssel hat nicht 32 Byte").into());
        }
        k.copy_from_slice(&key);
        Ok(Uint8Array::from(Peer::decrypt_with_key(&ciphertext, &k).map_err(js)?.as_slice()))
    }

    pub fn members(&self) -> Array {
        self.inner.borrow().members().iter().map(|m| JsValue::from(Uint8Array::from(m.as_slice()))).collect()
    }

    #[wasm_bindgen(js_name = hasKey)]
    pub fn has_key(&self) -> bool {
        self.inner.borrow().has_key()
    }

    #[wasm_bindgen(js_name = exportState)]
    pub fn export_state(&self) -> Result<Uint8Array, JsValue> {
        Ok(Uint8Array::from(self.inner.borrow().export_state().map_err(js)?.as_slice()))
    }
}
