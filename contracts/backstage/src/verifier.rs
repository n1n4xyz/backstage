//! Groth16 verifier over BN254, using Stellar's native host functions
//! (CAP-0074, Protocol 25+). Proofs come from Circom + snarkjs with the
//! default bn128 curve.

use soroban_sdk::{
    contracttype,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Bn254Fr},
    vec, Env, Vec,
};

#[derive(Clone)]
#[contracttype]
pub struct VerificationKey {
    pub alpha: Bn254G1Affine,
    pub beta: Bn254G2Affine,
    pub gamma: Bn254G2Affine,
    pub delta: Bn254G2Affine,
    pub ic: Vec<Bn254G1Affine>,
}

#[derive(Clone)]
#[contracttype]
pub struct Proof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
}

/// Returns None if the key does not match the number of public signals.
pub fn verify(env: &Env, vk: &VerificationKey, proof: &Proof, pub_signals: &Vec<Bn254Fr>) -> Option<bool> {
    if pub_signals.len() + 1 != vk.ic.len() {
        return None;
    }
    let bn = env.crypto().bn254();

    // vk_x = ic[0] + sum(pub_signals[i] * ic[i + 1])
    let mut vk_x = vk.ic.get(0).unwrap();
    for (s, v) in pub_signals.iter().zip(vk.ic.iter().skip(1)) {
        let prod = bn.g1_mul(&v, &s);
        vk_x = bn.g1_add(&vk_x, &prod);
    }

    // e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
    let neg_a = -proof.a.clone();
    let vp1 = vec![env, neg_a, vk.alpha.clone(), vk_x, proof.c.clone()];
    let vp2 = vec![env, proof.b.clone(), vk.beta.clone(), vk.gamma.clone(), vk.delta.clone()];
    Some(bn.pairing_check(vp1, vp2))
}
