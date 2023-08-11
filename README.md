# Contract

[contracts/algo-did.algo.ts](./contracts/algo-did.algo.ts) is a smart contract for mapping public keys to a DID document.


# SDK

[src/index.ts](./src/index.ts) is an SDK for uploading and resolving DID Documents.

## Methods

### uploadDIDDocument


Uploads a DID document for a public key in an Algorand DID contract. This function will upload the data to box storage and then read back the data for validation.

## resolveDID

Given a DID (`algo:did:${address}-${appID}`), returns the data stored in box storage of the given app ID for the given address.

# Tests

[__test\__/algo-did.test.ts](./__test__/algo-did.test.ts) contains tests for uploading and resolving both big (multi-box) and small (single-box) documents.

# Missing Features

* Currently no way to delete/update documents
* SDK is missing JSON LD validation for document uploading

