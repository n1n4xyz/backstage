#![no_std]
//! Backstage: creator-owned fan support on Stellar.
//!
//! Phase 1 in this contract:
//! - Open tips in USDC
//! - Memberships: fans pay in USDC and register an anonymous identity commitment
//! - Private membership proofs: Groth16 over BN254, verified on-chain
//! - Donation-only crowdfunding campaigns
//!
//! Hidden tip amounts and senders (Confidential Tokens) are not in this version.

mod verifier;
#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, crypto::bn254::Bn254Fr, token,
    vec, Address, BytesN, Env, U256,
};
pub use verifier::{Proof, VerificationKey};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    CreatorExists = 1,
    UnknownCreator = 2,
    InvalidAmount = 3,
    CommitmentExists = 4,
    NoMembersRoot = 5,
    NullifierUsed = 6,
    InvalidProof = 7,
    MalformedKey = 8,
    UnknownCampaign = 9,
    CampaignClosed = 10,
}

#[derive(Clone)]
#[contracttype]
pub struct Creator {
    pub price: i128,
    /// Poseidon Merkle root over all member commitments. Set by the creator.
    pub members_root: Option<BytesN<32>>,
    pub member_count: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct Campaign {
    pub creator: Address,
    pub goal: i128,
    pub raised: i128,
    pub open: bool,
}

#[contracttype]
enum DataKey {
    Admin,
    Usdc,
    Vk,
    Creator(Address),
    Commitment(Address, BytesN<32>),
    Nullifier(BytesN<32>),
    Campaign(u32),
    CampaignCount,
}

#[contractevent]
pub struct Tipped {
    #[topic]
    pub creator: Address,
    pub amount: i128,
}

#[contractevent]
pub struct Joined {
    #[topic]
    pub creator: Address,
    pub commitment: BytesN<32>,
    pub index: u32,
}

#[contractevent]
pub struct MemberVerified {
    #[topic]
    pub creator: Address,
    pub nullifier: BytesN<32>,
    pub scope: BytesN<32>,
}

#[contractevent]
pub struct Donated {
    #[topic]
    pub campaign: u32,
    pub amount: i128,
}

#[contract]
pub struct Backstage;

#[contractimpl]
impl Backstage {
    /// `usdc` is the USDC token contract. `vk` is the verification key of
    /// circuits/membership.circom. `admin` can replace the key later, so the
    /// contract can go live with a placeholder key before the circuit setup
    /// is done.
    pub fn __constructor(env: Env, admin: Address, usdc: Address, vk: VerificationKey) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        env.storage().instance().set(&DataKey::Vk, &vk);
    }

    /// Replace the verification key. Admin only.
    pub fn set_vk(env: Env, vk: VerificationKey) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Vk, &vk);
    }

    // ---------- creators ----------

    pub fn register_creator(env: Env, creator: Address, price: i128) -> Result<(), Error> {
        creator.require_auth();
        if price <= 0 {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::Creator(creator.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::CreatorExists);
        }
        let c = Creator { price, members_root: None, member_count: 0 };
        env.storage().persistent().set(&key, &c);
        Ok(())
    }

    pub fn creator(env: Env, creator: Address) -> Result<Creator, Error> {
        load_creator(&env, &creator)
    }

    // ---------- open tips ----------

    pub fn tip(env: Env, fan: Address, creator: Address, amount: i128) -> Result<(), Error> {
        fan.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        load_creator(&env, &creator)?;
        usdc(&env).transfer(&fan, &creator, &amount);
        Tipped { creator, amount }.publish(&env);
        Ok(())
    }

    // ---------- memberships ----------

    /// Fan pays the membership price and registers an identity commitment
    /// (Poseidon(secret), computed off-chain). The commitment reveals nothing
    /// about the fan. The payment itself is still a public USDC transfer, so
    /// fans who want full privacy should pay from a fresh wallet.
    pub fn join(env: Env, fan: Address, creator: Address, commitment: BytesN<32>) -> Result<u32, Error> {
        fan.require_auth();
        let mut c = load_creator(&env, &creator)?;
        let ckey = DataKey::Commitment(creator.clone(), commitment.clone());
        if env.storage().persistent().has(&ckey) {
            return Err(Error::CommitmentExists);
        }
        usdc(&env).transfer(&fan, &creator, &c.price);

        let index = c.member_count;
        env.storage().persistent().set(&ckey, &index);
        c.member_count += 1;
        env.storage().persistent().set(&DataKey::Creator(creator.clone()), &c);
        Joined { creator, commitment, index }.publish(&env);
        Ok(index)
    }

    /// Creator publishes the Poseidon Merkle root over all commitments, in
    /// the order of the Joined events.
    pub fn set_members_root(env: Env, creator: Address, root: BytesN<32>) -> Result<(), Error> {
        creator.require_auth();
        let mut c = load_creator(&env, &creator)?;
        c.members_root = Some(root);
        env.storage().persistent().set(&DataKey::Creator(creator), &c);
        Ok(())
    }

    /// Anyone proves "I am a member of this creator" without revealing which
    /// member. `scope` binds the proof to one action (for example a post id or
    /// an epoch). The nullifier stops the same proof being used twice.
    ///
    /// Public signals, in snarkjs order: [nullifier_hash, root, scope].
    pub fn prove_membership(
        env: Env,
        creator: Address,
        proof: Proof,
        nullifier: BytesN<32>,
        scope: BytesN<32>,
    ) -> Result<(), Error> {
        let c = load_creator(&env, &creator)?;
        let root = c.members_root.ok_or(Error::NoMembersRoot)?;
        let nkey = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&nkey) {
            return Err(Error::NullifierUsed);
        }

        let vk: VerificationKey = env.storage().instance().get(&DataKey::Vk).unwrap();
        let signals = vec![
            &env,
            to_fr(&env, &nullifier),
            to_fr(&env, &root),
            to_fr(&env, &scope),
        ];
        match verifier::verify(&env, &vk, &proof, &signals) {
            None => return Err(Error::MalformedKey),
            Some(false) => return Err(Error::InvalidProof),
            Some(true) => {}
        }

        env.storage().persistent().set(&nkey, &true);
        MemberVerified { creator, nullifier, scope }.publish(&env);
        Ok(())
    }

    // ---------- crowdfunding (donations and rewards only) ----------

    pub fn create_campaign(env: Env, creator: Address, goal: i128) -> Result<u32, Error> {
        creator.require_auth();
        load_creator(&env, &creator)?;
        if goal <= 0 {
            return Err(Error::InvalidAmount);
        }
        let id: u32 = env.storage().instance().get(&DataKey::CampaignCount).unwrap_or(0);
        let camp = Campaign { creator, goal, raised: 0, open: true };
        env.storage().persistent().set(&DataKey::Campaign(id), &camp);
        env.storage().instance().set(&DataKey::CampaignCount, &(id + 1));
        Ok(id)
    }

    /// Donations go straight to the creator. There is no refund and no return.
    pub fn donate(env: Env, fan: Address, campaign: u32, amount: i128) -> Result<(), Error> {
        fan.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::Campaign(campaign);
        let mut camp: Campaign = env.storage().persistent().get(&key).ok_or(Error::UnknownCampaign)?;
        if !camp.open {
            return Err(Error::CampaignClosed);
        }
        usdc(&env).transfer(&fan, &camp.creator, &amount);
        camp.raised += amount;
        env.storage().persistent().set(&key, &camp);
        Donated { campaign, amount }.publish(&env);
        Ok(())
    }

    pub fn close_campaign(env: Env, campaign: u32) -> Result<(), Error> {
        let key = DataKey::Campaign(campaign);
        let mut camp: Campaign = env.storage().persistent().get(&key).ok_or(Error::UnknownCampaign)?;
        camp.creator.require_auth();
        camp.open = false;
        env.storage().persistent().set(&key, &camp);
        Ok(())
    }

    pub fn campaign(env: Env, campaign: u32) -> Result<Campaign, Error> {
        env.storage().persistent().get(&DataKey::Campaign(campaign)).ok_or(Error::UnknownCampaign)
    }
}

fn load_creator(env: &Env, creator: &Address) -> Result<Creator, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Creator(creator.clone()))
        .ok_or(Error::UnknownCreator)
}

fn usdc(env: &Env) -> token::Client<'_> {
    let addr: Address = env.storage().instance().get(&DataKey::Usdc).unwrap();
    token::Client::new(env, &addr)
}

/// 32 big-endian bytes to a BN254 scalar.
fn to_fr(env: &Env, b: &BytesN<32>) -> Bn254Fr {
    Bn254Fr::from_u256(U256::from_be_bytes(env, &b.clone().into()))
}
