// Nativer Test der Hülle: prüft die Invarianten des Schlüssel-Ports direkt.
// KV1 frisches Geheimnis je Entfernung, KV2 genau die Verbleibenden (auch bei
// gleichzeitigen Entfernungen), KV5 Rotation auf Verlangen, KV6 Zusammenführung.
use beekem::id::TreeId;
use beekem_wasm::peer::Peer;
use keyhive_crypto::signer::memory::MemorySigner;
use keyhive_crypto::verifiable::Verifiable;
use rand::rngs::OsRng;

fn group_id() -> TreeId {
    TreeId(MemorySigner::generate(&mut OsRng).verifying_key())
}

fn deliver(to: &mut Peer, ops: &[Vec<u8>]) {
    for op in ops {
        let r = to.receive(op).expect("Operation annehmbar");
        assert_eq!(r.pending, 0, "Operation wartet auf Vorgänger");
    }
}

fn can_read(p: &mut Peer, ct: &[u8]) -> bool {
    p.decrypt(ct).is_ok()
}

#[tokio::test]
async fn kv1_kv5_entfernen_und_rotation() {
    let g = group_id();
    let mut alice = Peer::new();
    let mut bob = Peer::new();
    let mut carol = Peer::new();
    let mut log = alice.create(g).await.unwrap();
    bob.join(g);
    carol.join(g);
    log.push(alice.add(bob.id(), bob.share_key()).await.unwrap().unwrap());
    log.push(alice.add(carol.id(), carol.share_key()).await.unwrap().unwrap());
    deliver(&mut bob, &log);
    deliver(&mut carol, &log);

    let s = alice.encrypt([1; 32], vec![], b"hallo").await.unwrap();
    if let Some(op) = &s.update_op {
        deliver(&mut bob, std::slice::from_ref(op));
        deliver(&mut carol, std::slice::from_ref(op));
    }
    assert!(can_read(&mut bob, &s.ciphertext) && can_read(&mut carol, &s.ciphertext));

    // KV1: Nach Carols Entfernung liest sie Neues nicht mehr.
    let rm = alice.remove(carol.id()).await.unwrap().unwrap();
    deliver(&mut bob, std::slice::from_ref(&rm));
    deliver(&mut carol, std::slice::from_ref(&rm));
    let s2 = bob.encrypt([2; 32], vec![[1; 32]], b"ohne-carol").await.unwrap();
    if let Some(op) = &s2.update_op {
        deliver(&mut alice, std::slice::from_ref(op));
        deliver(&mut carol, std::slice::from_ref(op));
    }
    assert!(can_read(&mut alice, &s2.ciphertext), "Alice muss lesen");
    assert!(!can_read(&mut carol, &s2.ciphertext), "Carol darf nicht lesen (KV1)");

    // KV5: Bobs Zustand wird erbeutet; nach Bobs Rotation liest der Dieb nichts Neues.
    let stolen = bob.export_state().unwrap();
    let mut thief = Peer::import_state(&stolen).unwrap();
    let before = alice.encrypt([3; 32], vec![[2; 32]], b"vor-rotation").await.unwrap();
    if let Some(op) = &before.update_op {
        deliver(&mut bob, std::slice::from_ref(op));
        deliver(&mut thief, std::slice::from_ref(op));
    }
    assert!(can_read(&mut thief, &before.ciphertext), "Positivkontrolle: Dieb liest vor der Rotation");
    let rot = bob.rotate().await.unwrap();
    deliver(&mut alice, std::slice::from_ref(&rot));
    deliver(&mut thief, std::slice::from_ref(&rot)); // der Dieb sieht allen Verkehr
    let after = alice.encrypt([4; 32], vec![[3; 32]], b"nach-rotation").await.unwrap();
    if let Some(op) = &after.update_op {
        deliver(&mut bob, std::slice::from_ref(op));
        deliver(&mut thief, std::slice::from_ref(op));
    }
    assert!(can_read(&mut bob, &after.ciphertext), "Bob liest nach seiner Rotation");
    assert!(!can_read(&mut thief, &after.ciphertext), "Dieb darf nach der Rotation nicht lesen (KV5)");
}

#[tokio::test]
async fn kv2_kv6_gleichzeitige_entfernungen() {
    let g = group_id();
    let mut alice = Peer::new();
    let mut bob = Peer::new();
    let mut carol = Peer::new();
    let mut dave = Peer::new();
    let mut log = alice.create(g).await.unwrap();
    for p in [&mut bob, &mut carol, &mut dave] {
        p.join(g);
    }
    for p in [&bob, &carol, &dave] {
        log.push(alice.add(p.id(), p.share_key()).await.unwrap().unwrap());
    }
    for p in [&mut bob, &mut carol, &mut dave] {
        deliver(p, &log);
    }
    // Partition {Alice, Carol} | {Bob, Dave}: Alice entfernt Carol, Bob entfernt Dave.
    let rm_carol = alice.remove(carol.id()).await.unwrap().unwrap();
    let rm_dave = bob.remove(dave.id()).await.unwrap().unwrap();
    deliver(&mut carol, std::slice::from_ref(&rm_carol));
    deliver(&mut dave, std::slice::from_ref(&rm_dave));
    // Zusammenführen (KV6): jeder bekommt die andere Entfernung.
    for (p, op) in [(&mut alice, &rm_dave), (&mut carol, &rm_dave), (&mut bob, &rm_carol), (&mut dave, &rm_carol)] {
        deliver(p, std::slice::from_ref(op));
    }
    // BeeKEM spielt gleichzeitige Strukturänderungen erst bei der nächsten
    // eigenen Operation ein; vorher zeigt der Baum noch den alten Stand.
    assert_eq!(alice.members().len(), 3, "vor dem Replay noch drei Blätter");

    // KV2: Alice schreibt (löst Replay und, ohne Schlüssel, eine Rotation aus).
    // Bob liest, Carol und Dave nicht.
    let s = alice.encrypt([9; 32], vec![], b"danach").await.unwrap();
    assert_eq!(alice.members().len(), 2, "nach dem Replay zwei Blätter (KV6)");
    assert!(s.update_op.is_some(), "ohne gemeinsamen Schlüssel muss eine Rotation mitgehen");
    for p in [&mut bob, &mut carol, &mut dave] {
        if let Some(op) = &s.update_op {
            deliver(p, std::slice::from_ref(op));
        }
    }
    assert_eq!(bob.members().len(), 2);
    assert!(can_read(&mut bob, &s.ciphertext), "Bob muss lesen");
    assert!(!can_read(&mut carol, &s.ciphertext), "Carol darf nicht lesen (KV2)");
    assert!(!can_read(&mut dave, &s.ciphertext), "Dave darf nicht lesen (KV2)");
    // Und Bob schreibt: Alice liest, die Entfernten nicht.
    let s2 = bob.encrypt([10; 32], vec![[9; 32]], b"von-bob").await.unwrap();
    for p in [&mut alice, &mut carol, &mut dave] {
        if let Some(op) = &s2.update_op {
            deliver(p, std::slice::from_ref(op));
        }
    }
    assert!(can_read(&mut alice, &s2.ciphertext));
    assert!(!can_read(&mut carol, &s2.ciphertext) && !can_read(&mut dave, &s2.ciphertext));
}
