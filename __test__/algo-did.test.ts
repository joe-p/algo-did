/* eslint-disable no-plusplus */
import * as algokit from '@algorandfoundation/algokit-utils';
import fs from 'fs';
import { ApplicationClient } from '@algorandfoundation/algokit-utils/types/app-client';
import {
  describe, expect, beforeAll, it,
} from '@jest/globals';
import algosdk from 'algosdk';
import { algodClient, kmdClient } from './common';
import appSpec from '../contracts/artifacts/AlgoDID.json';
import {
  resolveDID, uploadDIDDocument, deleteDIDDocument, updateDIDDocument,
} from '../src/index';

describe('Algorand DID', () => {
  /**
   * Large data (> 32k) to simulate a large DID Document
   * that needs to be put into multiple boxes
   */
  const bigData = fs.readFileSync(`${__dirname}/TEAL.pdf`);

  /**
   * Small data (< 32k) to simulate a small DID Document
   * that can fit into a single box
   */
  const smallJSONObject = { keyOne: 'foo', keyTwo: 'bar' };

  /** The public key for the user in the tests that has a big DID Document */
  const bigDataUserKey = algosdk.decodeAddress(algosdk.generateAccount().addr).publicKey;

  /** The public key for the user in the tests that has a small DID Document */
  const smallDataUserKey = algosdk.decodeAddress(algosdk.generateAccount().addr).publicKey;

  /** The public key for the user in the tests that updates their DID Document */
  const updateDataUserKey = algosdk.decodeAddress(algosdk.generateAccount().addr).publicKey;

  /** algokti appClient for interacting with the contract */
  let appClient: ApplicationClient;

  /** The account that will be used to create and call the contract */
  let sender: algosdk.Account;

  /** The ID of the contract */
  let appId: number;

  beforeAll(async () => {
    sender = await algokit.getDispenserAccount(algodClient, kmdClient);

    appClient = new ApplicationClient({
      resolveBy: 'id',
      id: 0,
      sender,
      app: JSON.stringify(appSpec),
    }, algodClient);

    await appClient.create({ method: 'createApplication', methodArgs: [], sendParams: { suppressLog: true } });

    await appClient.fundAppAccount({
      amount: algokit.microAlgos(100_000),
      sendParams: { suppressLog: true },
    });

    appId = Number((await appClient.getAppReference()).appId);
  });

  describe('uploadDIDDocument', () => {
    const uploadDIDDocumentTest = async (documentData: Buffer, userKey: Uint8Array) => {
      // Upload the DID Document and ensure there is no error
      // Resolution is in the next test
      await uploadDIDDocument(
        documentData,
        appId,
        userKey,
        sender,
        algodClient,
      );
    };

    it('uploads big (multi-box) data', async () => {
      await uploadDIDDocumentTest(bigData, bigDataUserKey);
    });

    it('uploads small (single-box) data', async () => {
      const data = Buffer.from(JSON.stringify(smallJSONObject));
      await uploadDIDDocumentTest(data, smallDataUserKey);
    });
  });

  describe('resolveDID', () => {
    it('resolves big (multi-box) data', async () => {
      const addr = algosdk.encodeAddress(bigDataUserKey);
      const resolvedData = await resolveDID(`did:algo:${addr}-${appId}`, algodClient);

      // Expect binary data to match
      expect(resolvedData.toString('hex')).toEqual(bigData.toString('hex'));
    });

    it('resolves small (single-box) data', async () => {
      const addr = algosdk.encodeAddress(smallDataUserKey);
      const resolvedData = await resolveDID(`did:algo:${addr}-${appId}`, algodClient);

      // Expect JSON object to match
      expect(resolvedData.toString()).toEqual(JSON.stringify(smallJSONObject));
    });
  });

  describe('deleteDIDDocument', () => {
    const deleteDIDDocumentTest = async (userKey: Uint8Array) => {
      await deleteDIDDocument(appId, userKey, sender, algodClient);

      const addr = algosdk.encodeAddress(userKey);
      await expect(resolveDID(`did:algo:${addr}-${appId}`, algodClient)).rejects.toThrow();
    };

    it('deletes big (multi-box) data', async () => {
      await deleteDIDDocumentTest(bigDataUserKey);
    });

    it('deletes small (single-box) data', async () => {
      await deleteDIDDocumentTest(smallDataUserKey);
    });

    it('returns MBR', async () => {
      const { appAddress } = await appClient.getAppReference();
      const appAmount = (await algodClient.accountInformation(appAddress).do()).amount;

      expect(appAmount).toBe(100_000);
    });
  });

  describe('updateDocument', () => {
    beforeAll(async () => {
      // Initially upload the big data as the DID Document
      await uploadDIDDocument(
        bigData,
        appId,
        updateDataUserKey,
        sender,
        algodClient,
      );
    });

    it('uploads and resolves new data', async () => {
      // Update the DID Document to be the small data
      const data = Buffer.from(JSON.stringify(smallJSONObject));
      await updateDIDDocument(
        data,
        appId,
        updateDataUserKey,
        sender,
        algodClient,
      );

      const addr = algosdk.encodeAddress(updateDataUserKey);
      const resolvedData = await resolveDID(`did:algo:${addr}-${appId}`, algodClient);

      expect(resolvedData.toString()).toEqual(JSON.stringify(smallJSONObject));
    });
  });
});
