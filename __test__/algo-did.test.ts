/* eslint-disable no-plusplus */
import * as algokit from '@algorandfoundation/algokit-utils';
import fs from 'fs';
import { ApplicationClient } from '@algorandfoundation/algokit-utils/types/app-client';
import {
  describe, expect, beforeAll, it, jest,
} from '@jest/globals';
import algosdk from 'algosdk';
import { algodClient, kmdClient } from './common';
import appSpec from '../contracts/artifacts/AlgoDID.json';
import { resolveDID, uploadDIDDocument } from '../src/index';

jest.setTimeout(20000)

describe('Algorand DID', () => {
  const bigData: Buffer = fs.readFileSync(`${__dirname}/DIDocument.json`);
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

    await appClient.create({ sendParams: { suppressLog: true } });

    await appClient.fundAppAccount({
      amount: algokit.microAlgos(100_000),
      sendParams: { suppressLog: true },
    });
  });

  describe('uploadDIDDocument and Resolve', () => {
    it('(LARGE) DIDocument upload and resolve', async () => {
      console.log(`uploading DIDocument ${bigData.toString()}`)
      const { appId } = await appClient.getAppReference();
      const addr = algosdk.encodeAddress(bigDataPubKey);

      // Large upload
      await uploadDIDDocument(bigData, Number(appId), bigDataPubKey, sender, algodClient);

      // Reconstruct DID from several boxes
      const resolvedData: Buffer = await resolveDID(`did:algo:${addr}-${appId}`, algodClient);
      expect(resolvedData.toString('hex')).toEqual(bigData.toString('hex'))
    })

    it('(SMALL) DIDocument upload and resolve', async () => {
      console.log(`uploading DIDocument ${smallJSONObject.toString()}`)
      const { appId } = await appClient.getAppReference();
      const addr = algosdk.encodeAddress(smallDataPubKey);

      // Small upload
      await uploadDIDDocument(Buffer.from(JSON.stringify(smallJSONObject)),
        Number(appId),
        smallDataPubKey,
        sender,
        algodClient);

      // Reconstruct DID from several boxes
      const resolvedData: Buffer = await resolveDID(`did:algo:${addr}-${appId}`, algodClient);
      expect(resolvedData.toString('hex')).toEqual(Buffer.from(JSON.stringify(smallJSONObject)).toString('hex'))
    })
  })

  // describe('uploadDIDDocument', () => {
  //   it('uploads big (multi-box) data', async () => {
  //     const { appId } = await appClient.getAppReference();

  //     await uploadDIDDocument(
  //       bigData,
  //       Number(appId),
  //       bigDataPubKey,
  //       sender,
  //       algodClient,
  //     );
  //   });

  //   it('uploads small (single-box) data', async () => {
  //     const { appId } = await appClient.getAppReference();
  //     const data = Buffer.from(JSON.stringify(smallJSONObject));

  //     await uploadDIDDocument(
  //       data,
  //       Number(appId),
  //       smallDataPubKey,
  //       sender,
  //       algodClient,
  //     );
  //   });
  // });

  // describe('resolveDID', () => {
  //   it('resolves big (multi-box) data', async () => {
  //     const { appId } = await appClient.getAppReference();

  //     const addr = algosdk.encodeAddress(bigDataPubKey);

  //     const resolvedData = await resolveDID(`did:algo:${addr}-${appId}`, algodClient);

  //     expect(resolvedData.toString('hex')).toEqual(bigData.toString('hex'));
  //   });

  //   it('resolves small (single-box) data', async () => {
  //     const { appId } = await appClient.getAppReference();

  //     const addr = algosdk.encodeAddress(smallDataPubKey);

  //     const resolvedData = await resolveDID(`did:algo:${addr}-${appId}`, algodClient);

  //     expect(resolvedData.toString()).toEqual(JSON.stringify(smallJSONObject));
  //   });
  // });
})
