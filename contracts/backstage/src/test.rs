#![cfg(test)]
use super::*;
use soroban_sdk::{
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine},
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Env,
};

fn g1(env: &Env) -> Bn254G1Affine {
    Bn254G1Affine::from_bytes(BytesN::from_array(env, &[0u8; 64]))
}
fn g2(env: &Env) -> Bn254G2Affine {
    Bn254G2Affine::from_bytes(BytesN::from_array(env, &[0u8; 128]))
}

/// Placeholder key. Replace with the real key exported from snarkjs
/// (see README) to test the proof path.
fn dummy_vk(env: &Env) -> VerificationKey {
    VerificationKey {
        alpha: g1(env),
        beta: g2(env),
        gamma: g2(env),
        delta: g2(env),
        ic: vec![env, g1(env), g1(env), g1(env), g1(env)],
    }
}

struct Setup<'a> {
    env: Env,
    client: BackstageClient<'a>,
    usdc: TokenClient<'a>,
    creator: Address,
    fan: Address,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let usdc_addr = sac.address();
    let creator = Address::generate(&env);
    let fan = Address::generate(&env);
    StellarAssetClient::new(&env, &usdc_addr).mint(&fan, &1_000_0000000);

    let admin = Address::generate(&env);
    let id = env.register(Backstage, (admin, usdc_addr.clone(), dummy_vk(&env)));
    let client = BackstageClient::new(&env, &id);
    let usdc = TokenClient::new(&env, &usdc_addr);
    Setup { env, client, usdc, creator, fan }
}

#[test]
fn tip_goes_to_creator() {
    let s = setup();
    s.client.register_creator(&s.creator, &5_0000000);
    s.client.tip(&s.fan, &s.creator, &2_0000000);
    assert_eq!(s.usdc.balance(&s.creator), 2_0000000);
}

#[test]
fn join_charges_price_and_stores_commitment() {
    let s = setup();
    s.client.register_creator(&s.creator, &5_0000000);
    let commitment = BytesN::from_array(&s.env, &[7u8; 32]);
    let idx = s.client.join(&s.fan, &s.creator, &commitment);
    assert_eq!(idx, 0);
    assert_eq!(s.usdc.balance(&s.creator), 5_0000000);
    assert_eq!(s.client.creator(&s.creator).member_count, 1);

    let again = s.client.try_join(&s.fan, &s.creator, &commitment);
    assert_eq!(again, Err(Ok(Error::CommitmentExists)));
}

#[test]
fn proof_needs_members_root() {
    let s = setup();
    s.client.register_creator(&s.creator, &5_0000000);
    let proof = Proof { a: g1(&s.env), b: g2(&s.env), c: g1(&s.env) };
    let zero = BytesN::from_array(&s.env, &[0u8; 32]);
    let r = s.client.try_prove_membership(&s.creator, &proof, &zero, &zero);
    assert_eq!(r, Err(Ok(Error::NoMembersRoot)));
}

#[test]
fn donations_reach_creator() {
    let s = setup();
    s.client.register_creator(&s.creator, &5_0000000);
    let id = s.client.create_campaign(&s.creator, &100_0000000);
    s.client.donate(&s.fan, &id, &10_0000000);
    assert_eq!(s.client.campaign(&id).raised, 10_0000000);
    assert_eq!(s.usdc.balance(&s.creator), 10_0000000);

    s.client.close_campaign(&id);
    let r = s.client.try_donate(&s.fan, &id, &1);
    assert_eq!(r, Err(Ok(Error::CampaignClosed)));
}

#[test]
fn admin_can_replace_vk() {
    let s = setup();
    s.client.set_vk(&dummy_vk(&s.env));
}
