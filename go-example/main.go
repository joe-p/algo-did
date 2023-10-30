package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"strings"

	"github.com/algorand/go-algorand-sdk/v2/abi"
	"github.com/algorand/go-algorand-sdk/v2/client/kmd"
	"github.com/algorand/go-algorand-sdk/v2/client/v2/algod"
	"github.com/algorand/go-algorand-sdk/v2/crypto"
	"github.com/algorand/go-algorand-sdk/v2/transaction"
	"github.com/algorand/go-algorand-sdk/v2/types"

	"encoding/base64"
)

var (
	ALGOD_ADDRESS = "http://localhost"
	ALGOD_PORT    = "4001"
	ALGOD_TOKEN   = strings.Repeat("a", 64)

	INDEXER_URL   = "http://localhost"
	INDEXER_PORT  = "8980"
	INDEXER_TOKEN = strings.Repeat("a", 64)

	KMD_ADDRESS = "http://localhost:4002"
	KMD_TOKEN   = strings.Repeat("a", 64)

	KMD_WALLET_NAME     = "unencrypted-default-wallet"
	KMD_WALLET_PASSWORD = ""

	COST_PER_BYTE = 400
	COST_PER_BOX  = 2500
	MAX_BOX_SIZE  = 32768
)

func GetKmdClient() kmd.Client {
	kmdClient, err := kmd.MakeClient(
		KMD_ADDRESS,
		KMD_TOKEN,
	)

	if err != nil {
		log.Fatalf("Failed to create kmd client: %s", err)
	}

	return kmdClient
}

func GetSandboxAccounts() ([]crypto.Account, error) {
	client := GetKmdClient()

	resp, err := client.ListWallets()
	if err != nil {
		return nil, fmt.Errorf("Failed to list wallets: %+v", err)
	}

	var walletId string
	for _, wallet := range resp.Wallets {
		if wallet.Name == KMD_WALLET_NAME {
			walletId = wallet.ID
		}
	}

	if walletId == "" {
		return nil, fmt.Errorf("No wallet named %s", KMD_WALLET_NAME)
	}

	whResp, err := client.InitWalletHandle(walletId, KMD_WALLET_PASSWORD)
	if err != nil {
		return nil, fmt.Errorf("Failed to init wallet handle: %+v", err)
	}

	addrResp, err := client.ListKeys(whResp.WalletHandleToken)
	if err != nil {
		return nil, fmt.Errorf("Failed to list keys: %+v", err)
	}

	var accts []crypto.Account
	for _, addr := range addrResp.Addresses {
		expResp, err := client.ExportKey(whResp.WalletHandleToken, KMD_WALLET_PASSWORD, addr)
		if err != nil {
			return nil, fmt.Errorf("Failed to export key: %+v", err)
		}

		acct, err := crypto.AccountFromPrivateKey(expResp.PrivateKey)
		if err != nil {
			return nil, fmt.Errorf("Failed to create account from private key: %+v", err)
		}

		accts = append(accts, acct)
	}

	return accts, nil
}

func CreateApp(
	algodClient *algod.Client,
	contract *abi.Contract,
	sender types.Address,
	signer transaction.TransactionSigner,
) uint64 {
	atc := transaction.AtomicTransactionComposer{}

	// Grab the method from out contract object
	method, err := contract.GetMethodByName("createApplication")
	if err != nil {
		log.Fatalf("failed to get add method: %s", err)
	}

	sp, err := algodClient.SuggestedParams().Do(context.Background())
	if err != nil {
		log.Fatalf("failed to get suggested params: %s", err)
	}

	approval, err := os.ReadFile("../contracts/artifacts/AlgoDID.approval.teal")
	if err != nil {
		log.Fatalf("failed to read contract file: %s", err)
	}

	clear, err := os.ReadFile("../contracts/artifacts/AlgoDID.clear.teal")
	if err != nil {
		log.Fatalf("failed to read contract file: %s", err)
	}

	compiledApproval, err := algodClient.TealCompile(approval).Do(context.Background())
	if err != nil {
		log.Fatalf("failed to compile approval: %s", err)
	}

	compiledClear, err := algodClient.TealCompile(clear).Do(context.Background())
	if err != nil {
		log.Fatalf("failed to compile clear: %s", err)
	}

	approvalProgram, err := base64.StdEncoding.DecodeString(compiledApproval.Result)
	if err != nil {
		log.Fatalf("failed to decode approval program: %s", err)
	}

	clearProgram, err := base64.StdEncoding.DecodeString(compiledClear.Result)
	if err != nil {
		log.Fatalf("failed to decode clear program: %s", err)
	}

	mcp := transaction.AddMethodCallParams{
		AppID:           0,
		Sender:          sender,
		SuggestedParams: sp,
		OnComplete:      types.NoOpOC,
		Signer:          signer,
		Method:          method,
		MethodArgs:      []interface{}{},
		ApprovalProgram: approvalProgram,
		ClearProgram:    clearProgram,
		GlobalSchema:    types.StateSchema{NumUint: 1},
	}

	if err := atc.AddMethodCall(mcp); err != nil {
		log.Fatalf("failed to add method call: %s", err)
	}

	result, err := atc.Execute(algodClient, context.Background(), 3)

	if err != nil {
		log.Fatalf("failed to execute atomic transaction: %s", err)
	}

	confirmedTxn, err := transaction.WaitForConfirmation(algodClient, result.TxIDs[0], 4, context.Background())

	appID := confirmedTxn.ApplicationIndex

	fundAtc := transaction.AtomicTransactionComposer{}

	mbrPayment, err := transaction.MakePaymentTxn(
		sender.String(),
		crypto.GetApplicationAddress(appID).String(),
		uint64(100_000),
		nil,
		"",
		sp,
	)

	if err != nil {
		log.Fatalf("failed to make payment txn: %s", err)
	}

	var mbrPaymentWithSigner transaction.TransactionWithSigner

	mbrPaymentWithSigner.Txn = mbrPayment
	mbrPaymentWithSigner.Signer = signer

	err = fundAtc.AddTransaction(mbrPaymentWithSigner)
	if err != nil {
		log.Fatalf("failed to add transaction: %s", err)
	}

	_, err = fundAtc.Execute(algodClient, context.Background(), 3)
	if err != nil {
		log.Fatalf("failed to execute atomic transaction: %s", err)
	}

	return confirmedTxn.ApplicationIndex
}

/*
const ceilBoxes = Math.ceil(data.byteLength / MAX_BOX_SIZE);

const endBoxSize = data.byteLength % MAX_BOX_SIZE;

const totalCost = ceilBoxes * COST_PER_BOX // cost of data boxes
+ (ceilBoxes - 1) * MAX_BOX_SIZE * COST_PER_BYTE // cost of data
+ ceilBoxes * 8 * COST_PER_BYTE // cost of data keys
+ endBoxSize * COST_PER_BYTE // cost of last data box
+ COST_PER_BOX + (8 + 8 + 1 + 8 + 32 + 8) * COST_PER_BYTE; // cost of metadata box

	const mbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
		from: sender.addr,
		to: (await appClient.getAppReference()).appAddress,
		amount: totalCost,
		suggestedParams: await algodClient.getTransactionParams().do(),
	});

	const appCallResult: AppCallTransactionResult = await appClient.call({
		method: 'startUpload',
		methodArgs: [pubKey, ceilBoxes, endBoxSize, mbrPayment],
		boxes: [
		pubKey,
		],
		sendParams: { suppressLog: true },
	});
*/
func StartUpload(
	algodClient *algod.Client,
	appID uint64,
	contract *abi.Contract,
	sender types.Address,
	signer transaction.TransactionSigner,
	data []byte,
	pubKey []byte,
) {
	ceilBoxes := int(math.Ceil(float64(len(data)) / float64(MAX_BOX_SIZE)))
	endBoxSize := len(data) % MAX_BOX_SIZE

	totalCost := ceilBoxes*COST_PER_BOX + (ceilBoxes-1)*MAX_BOX_SIZE*COST_PER_BYTE + ceilBoxes*8*COST_PER_BYTE + endBoxSize*COST_PER_BYTE + COST_PER_BOX + (8+8+1+8+32+8)*COST_PER_BYTE

	atc := transaction.AtomicTransactionComposer{}

	// Grab the method from out contract object
	method, err := contract.GetMethodByName("startUpload")
	if err != nil {
		log.Fatalf("failed to get add method: %s", err)
	}

	sp, err := algodClient.SuggestedParams().Do(context.Background())
	if err != nil {
		log.Fatalf("failed to get suggested params: %s", err)
	}

	mbrPayment, err := transaction.MakePaymentTxn(
		sender.String(),
		crypto.GetApplicationAddress(appID).String(),
		uint64(totalCost),
		nil,
		"",
		sp,
	)

	var mbrPaymentWithSigner transaction.TransactionWithSigner

	mbrPaymentWithSigner.Txn = mbrPayment
	mbrPaymentWithSigner.Signer = signer

	if err != nil {
		log.Fatalf("failed to make payment txn: %s", err)
	}

	byteType, err := abi.TypeOf("address")
	if err != nil {
		log.Fatalf("failed to get type of address: %s", err)
	}

	pubKeyAbiValue, err := byteType.Encode(pubKey)
	if err != nil {
		log.Fatalf("failed to encode pubKey: %s", err)
	}

	boxRefs := []types.AppBoxReference{{AppID: appID, Name: pubKey}}

	mcp := transaction.AddMethodCallParams{
		AppID:           appID,
		Sender:          sender,
		SuggestedParams: sp,
		OnComplete:      types.NoOpOC,
		Signer:          signer,
		Method:          method,
		BoxReferences:   boxRefs,
		MethodArgs:      []interface{}{pubKeyAbiValue, ceilBoxes, endBoxSize, mbrPaymentWithSigner},
	}

	if err := atc.AddMethodCall(mcp); err != nil {
		log.Fatalf("failed to add method call: %s", err)
	}

	_, err = atc.Execute(algodClient, context.Background(), 3)

	if err != nil {
		log.Fatalf("failed to execute atomic transaction: %s", err)
	}
}

func main() {

	b, err := os.ReadFile("../contracts/artifacts/AlgoDID.abi.json")
	if err != nil {
		log.Fatalf("failed to read contract file: %s", err)
	}

	contract := &abi.Contract{}
	if err := json.Unmarshal(b, contract); err != nil {
		log.Fatalf("failed to unmarshal contract: %s", err)
	}

	// Create a new algod client, configured to connect to out local sandbox
	var algodAddress = "http://localhost:4001"
	var algodToken = strings.Repeat("a", 64)
	algodClient, _ := algod.MakeClient(
		algodAddress,
		algodToken,
	)

	accts, err := GetSandboxAccounts()
	if err != nil {
		log.Fatalf("Failed to get sandbox accounts: %+v", err)
	}

	sender := accts[0]

	signer := transaction.BasicAccountTransactionSigner{Account: sender}

	appID := CreateApp(algodClient, contract, sender.Address, signer)

	StartUpload(
		algodClient,
		appID,
		contract,
		sender.Address,
		signer,
		[]byte("hello world"),
		sender.PublicKey,
	)
}
