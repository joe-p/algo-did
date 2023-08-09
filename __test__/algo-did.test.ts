/* eslint-disable no-plusplus */
import * as algokit from '@algorandfoundation/algokit-utils';
import fs from 'fs';
import { ApplicationClient } from '@algorandfoundation/algokit-utils/types/app-client';
import {
  describe, test, expect, beforeAll, beforeEach,
} from '@jest/globals';
import algosdk from 'algosdk';
import { algodClient, kmdClient } from './common';
import appSpec from '../contracts/artifacts/AlgoDID.json';

const COST_PER_BYTE = 400;
const COST_PER_BOX = 2500;
const MAX_BOX_SIZE = 32768;

const BYTES_PER_CALL = 2048
- 4 // 4 bytes for the method selector
- 64 // 64 bytes for the name
- 8 // 8 bytes for the box index
- 8; // 8 bytes for the offset
type DataInfo = {start: BigInt, end: BigInt, uploading: BigInt, endSize: BigInt};

// pubkey encoding for now use Algorand base32 address
// did = did:algo:<pubKey>-<providerAppId>
// async function resolveDID(did: string) {}

async function uploadDIDDocument(
  data: Buffer,
  appID: number,
  pubKey: Uint8Array,
  sender: algosdk.Account,
): Promise<Buffer[]> {
  const appClient = new ApplicationClient({
    resolveBy: 'id',
    id: appID,
    sender,
    app: JSON.stringify(appSpec),
  }, algodClient);

  const numBoxes = Math.floor(data.byteLength / MAX_BOX_SIZE);
  const boxData: Buffer[] = [];

  for (let i = 0; i < numBoxes; i++) {
    const box = data.subarray(i * MAX_BOX_SIZE, (i + 1) * MAX_BOX_SIZE);
    boxData.push(box);
  }

  boxData.push(data.subarray(numBoxes * MAX_BOX_SIZE, data.byteLength));

  const suggestedParams = await algodClient.getTransactionParams().do();

  const boxPromises = boxData.map(async (box, boxIndex) => {
    const numChunks = Math.ceil(box.byteLength / BYTES_PER_CALL);

    const chunks: Buffer[] = [];

    for (let i = 0; i < numChunks; i++) {
      chunks.push(box.subarray(i * BYTES_PER_CALL, (i + 1) * BYTES_PER_CALL));
    }

    const boxRef = { appIndex: 0, name: algosdk.encodeUint64(boxIndex) };
    const boxes: algosdk.BoxReference[] = new Array(7).fill(boxRef);

    boxes.push({ appIndex: 0, name: pubKey });

    const firstGroup = chunks.slice(0, 8);
    const secondGroup = chunks.slice(8);

    const firstAtc = new algosdk.AtomicTransactionComposer();
    firstGroup.forEach((chunk, i) => {
      firstAtc.addMethodCall({
        method: appClient.getABIMethod('upload')!,
        methodArgs: [pubKey, boxIndex, BYTES_PER_CALL * i, chunk],
        boxes,
        suggestedParams,
        sender: sender.addr,
        signer: algosdk.makeBasicAccountTransactionSigner(sender),
        appID,
      });
    });

    await firstAtc.execute(algodClient, 3);

    if (secondGroup.length === 0) return;

    const secondAtc = new algosdk.AtomicTransactionComposer();
    secondGroup.forEach((chunk, i) => {
      secondAtc.addMethodCall({
        method: appClient.getABIMethod('upload')!,
        methodArgs: [pubKey, boxIndex, BYTES_PER_CALL * (i + 8), chunk],
        boxes,
        suggestedParams,
        sender: sender.addr,
        signer: algosdk.makeBasicAccountTransactionSigner(sender),
        appID,
      });
    });

    await secondAtc.execute(algodClient, 3);
  });

  await Promise.all(boxPromises);

  await appClient.call({
    method: 'finishUpload',
    methodArgs: [pubKey],
    boxes: [
      pubKey,
    ],
    sendParams: { suppressLog: true },
  });

  return boxData;
}

describe('Big Box', () => {
  let data: Buffer;
  let appClient: ApplicationClient;
  let sender: algosdk.Account;

  beforeAll(async () => {
    sender = await algokit.getDispenserAccount(algodClient, kmdClient);
    data = fs.readFileSync(`${__dirname}/TEAL.pdf`);

    appClient = new ApplicationClient({
      resolveBy: 'id',
      id: 0,
      sender,
      app: JSON.stringify(appSpec),
    }, algodClient);

    await appClient.create({ sendParams: { suppressLog: true } });
  });

  test('startUpload', async () => {
    const numBoxes = Math.ceil(data.byteLength / MAX_BOX_SIZE);

    const endBoxSize = data.byteLength % MAX_BOX_SIZE;

    const totalCost = numBoxes * COST_PER_BOX
    + (numBoxes - 1) * MAX_BOX_SIZE * COST_PER_BYTE
    + numBoxes * 64 * COST_PER_BYTE
    + endBoxSize * COST_PER_BYTE;

    const mbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: sender.addr,
      to: (await appClient.getAppReference()).appAddress,
      amount: totalCost,
      suggestedParams: await algodClient.getTransactionParams().do(),
    });

    const pubKey = algosdk.decodeAddress(sender.addr).publicKey;

    await appClient.call({
      method: 'startUpload',
      methodArgs: [pubKey, numBoxes, endBoxSize, mbrPayment],
      boxes: [
        pubKey,
      ],
      sendParams: { suppressLog: true },
    });

    const res = await appClient.getBoxValueFromABIType(pubKey, algosdk.ABIType.from('(uint64,uint64,uint8,uint64)')) as BigInt[];
    const dataInfo: DataInfo = {
      start: res[0] as BigInt,
      end: res[1] as BigInt,
      uploading: res[2] as BigInt,
      endSize: res[3] as BigInt,
    };

    expect(dataInfo.start).toBe(0n);
    expect(dataInfo.end).toBe(BigInt(numBoxes - 1));
    expect(dataInfo.uploading).toBe(1n);
    expect(dataInfo.endSize).toBe(BigInt(endBoxSize));
  });

  test('upload', async () => {
    const { appId } = await appClient.getAppReference();
    const boxData = await uploadDIDDocument(
      data,
      Number(appId),
      algosdk.decodeAddress(sender.addr).publicKey,
      sender,
    );

    const boxValuePromises = boxData
      .map(async (_, boxIndex) => appClient.getBoxValue(algosdk.encodeUint64(boxIndex)));

    const boxValues = await Promise.all(boxValuePromises);

    boxValues.forEach((val, i) => {
      expect(Buffer.from(val).toString('hex')).toEqual(boxData[i].toString('hex'));
    });

    expect(Buffer.concat(boxValues).toString('hex')).toEqual(data.toString('hex'));
  });
});
