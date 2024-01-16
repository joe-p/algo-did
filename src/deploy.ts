import * as algokit from '@algorandfoundation/algokit-utils';
import { AlgoDidClient } from '../contracts/clients/AlgoDIDClient';

async function deploy() {
  const algod = algokit.getAlgoClient(algokit.getAlgoNodeConfig('testnet', 'algod'));

  const kmd = algokit.getAlgoKmdClient({
    server: 'http://localhost',
    port: 4002,
    token: 'a'.repeat(64),
  });

  // Use algokit to create a KMD account named 'deployer'
  const deployer = await algokit.getOrCreateKmdWalletAccount({
    name: 'deployer',
    // set fundWith to 0 so algokit doesn't try to fund the account from another kmd account
    fundWith: algokit.microAlgos(0),
  }, algod, kmd);

  const { amount } = await algod.accountInformation(deployer.addr).do();

  if (amount === 0) {
    throw Error(`Account ${deployer.addr} has no funds. Please fund it and try again.`);
  }

  const appClient = new AlgoDidClient(
    {
      sender: deployer,
      resolveBy: 'id',
      id: 0,
    },
    algod,
  );

  await appClient.create.createApplication({});
}

deploy();
