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
import { resolveDID, uploadDIDDocument, deleteDIDDocument } from '../src/index';

describe('Algorand DID', () => {
  const bigData = fs.readFileSync(`${__dirname}/TEAL.pdf`);
  const smallJSONObject = { keyOne: 'foo', keyTwo: 'bar' };
  let appClient: ApplicationClient;
  let sender: algosdk.Account;
  const bigDataPubKey = algosdk.decodeAddress(algosdk.generateAccount().addr).publicKey;
  const smallDataPubKey = algosdk.decodeAddress(algosdk.generateAccount().addr).publicKey;

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
  });

  describe('uploadDIDDocument', () => {
    it('uploads big (multi-box) data', async () => {
      const { appId } = await appClient.getAppReference();

      await uploadDIDDocument(
        bigData,
        Number(appId),
        bigDataPubKey,
        sender,
        algodClient,
      );
    });

    it('uploads small (single-box) data', async () => {
      const { appId } = await appClient.getAppReference();
      const data = Buffer.from(JSON.stringify(smallJSONObject));

      await uploadDIDDocument(
        data,
        Number(appId),
        smallDataPubKey,
        sender,
        algodClient,
      );
    });
  });

  describe('resolveDID', () => {
    it('resolves big (multi-box) data', async () => {
      const { appId } = await appClient.getAppReference();

      const addr = algosdk.encodeAddress(bigDataPubKey);

      const resolvedData = await resolveDID(`did:algo:${addr}-${appId}`, algodClient);

      expect(resolvedData.toString('hex')).toEqual(bigData.toString('hex'));
    });

    it('resolves small (single-box) data', async () => {
      const { appId } = await appClient.getAppReference();

      const addr = algosdk.encodeAddress(smallDataPubKey);

      const resolvedData = await resolveDID(`did:algo:${addr}-${appId}`, algodClient);

      expect(resolvedData.toString()).toEqual(JSON.stringify(smallJSONObject));
    });
  });

  describe('deleteDIDDocument', () => {
    it('deletes big (multi-box) data', async () => {
      const { appId } = await appClient.getAppReference();
      await deleteDIDDocument(Number(appId), bigDataPubKey, sender, algodClient);

      const addr = algosdk.encodeAddress(bigDataPubKey);
      await expect(resolveDID(`did:algo:${addr}-${appId}`, algodClient)).rejects.toThrow();
    });

    it('deletes small (single-box) data', async () => {
      const { appId } = await appClient.getAppReference();

      await deleteDIDDocument(Number(appId), smallDataPubKey, sender, algodClient);

      const addr = algosdk.encodeAddress(smallDataPubKey);
      await expect(resolveDID(`did:algo:${addr}-${appId}`, algodClient)).rejects.toThrow();
    });

    it('returns MBR', async () => {
      const { appAddress } = await appClient.getAppReference();
      const appAmount = (await algodClient.accountInformation(appAddress).do()).amount;

      expect(appAmount).toBe(100_000);
    });
  });
});
