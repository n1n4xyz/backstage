pragma circom 2.1.6;

// Backstage membership proof.
// Proves: "I know a secret whose commitment is in this creator's member tree"
// without revealing which member. The nullifier hash is unique per
// (secret, scope), so one member can act once per scope.
//
// Public signals in snarkjs order: [nullifierHash, root, scope]
// This order must match prove_membership in the contract.

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

template MerkleInclusion(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth]; // 0 = current node is left, 1 = right
    signal output root;

    component hashers[depth];
    component muxes[depth];
    signal levels[depth + 1];
    levels[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        muxes[i] = MultiMux1(2);
        muxes[i].c[0][0] <== levels[i];
        muxes[i].c[0][1] <== pathElements[i];
        muxes[i].c[1][0] <== pathElements[i];
        muxes[i].c[1][1] <== levels[i];
        muxes[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxes[i].out[0];
        hashers[i].inputs[1] <== muxes[i].out[1];
        levels[i + 1] <== hashers[i].out;
    }
    root <== levels[depth];
}

template Membership(depth) {
    // private
    signal input secret;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    // public
    signal input root;
    signal input scope;
    signal output nullifierHash;

    component commit = Poseidon(1);
    commit.inputs[0] <== secret;

    component tree = MerkleInclusion(depth);
    tree.leaf <== commit.out;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;

    component nul = Poseidon(2);
    nul.inputs[0] <== secret;
    nul.inputs[1] <== scope;
    nullifierHash <== nul.out;
}

// 2^16 = 65,536 members per creator.
component main { public [root, scope] } = Membership(16);
