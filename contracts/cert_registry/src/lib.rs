#![no_std]

use soroban_sdk::{contract, contractimpl, Bytes, Env, String};

#[contract]
pub struct CertRegistry;

#[contractimpl]
impl CertRegistry {
    pub fn set_hash(env: Env, cert_id: String, hash: Bytes) {
        env.storage().persistent().set(&cert_id, &hash);
    }

    pub fn get_hash(env: Env, cert_id: String) -> Bytes {
        env.storage()
            .persistent()
            .get(&cert_id)
            .unwrap_or(Bytes::new(&env))
    }
}

