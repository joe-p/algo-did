package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
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

	COST_PER_BYTE  = 400
	COST_PER_BOX   = 2500
	MAX_BOX_SIZE   = 32768
	BYTES_PER_CALL = 2048 - 4 - 34 - 8 - 8
)

/*
start := metadata.([]interface{})[0].(uint64)
end := metadata.([]interface{})[1].(uint64)
status := metadata.([]interface{})[2].(uint8)
endSize := metadata.([]interface{})[3].(uint64)
*/
type Metadata struct {
	Start   uint64
	End     uint64
	Status  uint8
	EndSize uint64
}

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

func SendTxGroup(
	algodClient *algod.Client,
	abiMethod abi.Method,
	bytesOffset int,
	pubKey []byte,
	boxes []types.AppBoxReference,
	boxIndex uint64,
	suggestedParams types.SuggestedParams,
	sender types.Address,
	signer transaction.TransactionSigner,
	appID uint64,
	group [][]byte,
) []string {
	atc := transaction.AtomicTransactionComposer{}

	for i, chunk := range group {
		atc.AddMethodCall(transaction.AddMethodCallParams{
			Method:          abiMethod,
			MethodArgs:      []interface{}{pubKey, boxIndex, BYTES_PER_CALL * (i + bytesOffset), chunk},
			BoxReferences:   boxes,
			SuggestedParams: suggestedParams,
			Sender:          sender,
			Signer:          signer,
			AppID:           appID,
		})
	}

	result, err := atc.Execute(algodClient, context.Background(), 3)
	if err != nil {
		log.Fatalf("failed to execute atomic transaction: %s", err)
	}

	return result.TxIDs
}

func GetMetadata(appID uint64, pubKey []byte, algodClient *algod.Client) Metadata {
	boxValue, err := algodClient.GetApplicationBoxByName(appID, pubKey).Do(context.Background())
	if err != nil {
		log.Fatalf("failed to read metadata box: %s", err)
	}

	metadataType, err := abi.TypeOf("(uint64,uint64,uint8,uint64,uint64)")
	if err != nil {
		log.Fatalf("failed to get type of metadata: %s", err)
	}

	metadata, err := metadataType.Decode(boxValue.Value)

	if err != nil {
		log.Fatalf("failed to decode metadata: %s", err)
	}

	return Metadata{
		Start:   metadata.([]interface{})[0].(uint64),
		End:     metadata.([]interface{})[1].(uint64),
		Status:  metadata.([]interface{})[2].(uint8),
		EndSize: metadata.([]interface{})[3].(uint64),
	}
}

func UploadDIDDocument(
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

	metadata := GetMetadata(appID, pubKey, algodClient)

	fmt.Printf("start: %d\n", metadata.Start)
	fmt.Printf("end: %d\n", metadata.End)
	fmt.Printf("status: %d\n", metadata.Start)
	fmt.Printf("endSize: %d\n", metadata.EndSize)

	numBoxes := int(math.Floor(float64(len(data)) / float64(MAX_BOX_SIZE)))

	fmt.Printf("numBoxes: %d\n", numBoxes)

	boxData := [][]byte{}
	for i := 0; i < numBoxes; i++ {
		upperBound := (i + 1) * MAX_BOX_SIZE
		if len(data) < upperBound {
			upperBound = len(data)
		}
		box := data[i*MAX_BOX_SIZE : upperBound]
		boxData = append(boxData, box)
	}

	// add data for the last box
	if len(data) > MAX_BOX_SIZE {
		boxData = append(boxData, data[numBoxes*MAX_BOX_SIZE:])
	}

	for boxIndexOffset, box := range boxData {
		boxIndex := metadata.Start + uint64(boxIndexOffset)
		encodedBoxIndex := make([]byte, 8)
		binary.BigEndian.PutUint64(encodedBoxIndex, boxIndex)

		numChunks := int(math.Ceil(float64(len(box)) / float64(BYTES_PER_CALL)))

		chunks := [][]byte{}
		for i := 0; i < numChunks; i++ {
			upperBound := (i + 1) * BYTES_PER_CALL
			if len(box) < upperBound {
				upperBound = len(box)
			}
			chunks = append(chunks, box[i*BYTES_PER_CALL:upperBound])
		}

		boxRef := types.AppBoxReference{AppID: appID, Name: encodedBoxIndex}
		boxes := []types.AppBoxReference{}
		for i := 0; i < 7; i++ {
			boxes = append(boxes, boxRef)
		}

		boxes = append(boxes, types.AppBoxReference{AppID: appID, Name: pubKey})

		fmt.Printf("boxIndex: %d\n", boxIndex)
		fmt.Printf("numChunks: %d\n", numChunks)

		uploadMethod, err := contract.GetMethodByName("upload")
		if err != nil {
			log.Fatalf("failed to get add method: %s", err)
		}

		SendTxGroup(algodClient, uploadMethod, 0, pubKey, boxes, boxIndex, sp, sender, signer, appID, chunks[:8])

		if numChunks > 8 {
			SendTxGroup(algodClient, uploadMethod, 0, pubKey, boxes, boxIndex, sp, sender, signer, appID, chunks[8:])
		}
	}

	/*
	  await appClient.call({
	    method: 'finishUpload',
	    methodArgs: [pubKey],
	    boxes: [
	      pubKey,
	    ],
	    sendParams: { suppressLog: true },
	  });
	*/

	finishUploadMethod, err := contract.GetMethodByName("finishUpload")
	if err != nil {
		log.Fatalf("failed to get add method: %s", err)
	}

	finishUploadMcp := transaction.AddMethodCallParams{
		AppID:           appID,
		Sender:          sender,
		SuggestedParams: sp,
		OnComplete:      types.NoOpOC,
		Signer:          signer,
		Method:          finishUploadMethod,
		BoxReferences:   []types.AppBoxReference{{AppID: appID, Name: pubKey}},
		MethodArgs:      []interface{}{pubKey},
	}

	finishAtc := transaction.AtomicTransactionComposer{}
	if err := finishAtc.AddMethodCall(finishUploadMcp); err != nil {
		log.Fatalf("failed to add method call: %s", err)
	}

	_, err = finishAtc.Execute(algodClient, context.Background(), 3)
}

/*
export async function deleteDIDDocument(

	appID: number,
	pubKey: Uint8Array,
	sender: algosdk.Account,
	algodClient: algosdk.Algodv2,

	): Promise<void> {
*/
func DeleteDIDDocument(
	appID uint64,
	pubKey []byte,
	sender types.Address,
	algodClient *algod.Client,
	contract *abi.Contract,
	signer transaction.TransactionSigner,
) {
	startAtc := transaction.AtomicTransactionComposer{}

	method, err := contract.GetMethodByName("startDelete")
	if err != nil {
		log.Fatalf("failed to get add method: %s", err)
	}

	sp, err := algodClient.SuggestedParams().Do(context.Background())
	if err != nil {
		log.Fatalf("failed to get suggested params: %s", err)
	}

	byteType, err := abi.TypeOf("address")
	if err != nil {
		log.Fatalf("failed to get type of address: %s", err)
	}

	pubKeyAbiValue, err := byteType.Encode(pubKey)
	if err != nil {
		log.Fatalf("failed to encode pubKey: %s", err)
	}

	mcp := transaction.AddMethodCallParams{
		AppID:           appID,
		Sender:          sender,
		SuggestedParams: sp,
		OnComplete:      types.NoOpOC,
		Signer:          signer,
		Method:          method,
		BoxReferences:   []types.AppBoxReference{{AppID: appID, Name: pubKey}},
		MethodArgs:      []interface{}{pubKeyAbiValue},
	}

	if err := startAtc.AddMethodCall(mcp); err != nil {
		log.Fatalf("failed to add method call: %s", err)
	}

	_, err = startAtc.Execute(algodClient, context.Background(), 3)

	if err != nil {
		log.Fatalf("failed to execute atomic transaction: %s", err)
	}

	metadata := GetMetadata(appID, pubKey, algodClient)

	/*
	 const atcs: {boxIndex: bigint, atc: algosdk.AtomicTransactionComposer}[] = [];
	  for (let boxIndex = metadata.start; boxIndex <= metadata.end; boxIndex += 1n) {
	    const atc = new algosdk.AtomicTransactionComposer();
	    const boxIndexRef = { appIndex: appID, name: algosdk.encodeUint64(boxIndex) };
	    atc.addMethodCall({
	      appID,
	      method: appClient.getABIMethod('deleteData')!,
	      methodArgs: [pubKey, boxIndex],
	      boxes: [
	        { appIndex: appID, name: pubKey },
	        boxIndexRef,
	        boxIndexRef,
	        boxIndexRef,
	        boxIndexRef,
	        boxIndexRef,
	        boxIndexRef,
	        boxIndexRef,
	      ],
	      suggestedParams: { ...suggestedParams, fee: 2000, flatFee: true },
	      sender: sender.addr,
	      signer: algosdk.makeBasicAccountTransactionSigner(sender),
	    });

	    for (let i = 0; i < 4; i += 1) {
	      atc.addMethodCall({
	        appID,
	        method: appClient.getABIMethod('dummy')!,
	        methodArgs: [],
	        boxes: [
	          boxIndexRef,
	          boxIndexRef,
	          boxIndexRef,
	          boxIndexRef,
	          boxIndexRef,
	          boxIndexRef,
	          boxIndexRef,
	          boxIndexRef,
	        ],
	        suggestedParams,
	        sender: sender.addr,
	        signer: algosdk.makeBasicAccountTransactionSigner(sender),
	        note: new Uint8Array(Buffer.from(`dummy ${i}`)),
	      });
	    }

	    atcs.push({ atc, boxIndex });
	  }

	*/

	atcs := []struct {
		boxIndex uint64
		atc      transaction.AtomicTransactionComposer
	}{}

	for boxIndex := metadata.Start; boxIndex <= metadata.End; boxIndex++ {
		atc := transaction.AtomicTransactionComposer{}
		encodedBoxIndex := make([]byte, 8)
		binary.BigEndian.PutUint64(encodedBoxIndex, boxIndex)

		boxIndexRef := types.AppBoxReference{AppID: appID, Name: encodedBoxIndex}

		deleteDataMethod, err := contract.GetMethodByName("deleteData")
		if err != nil {
			log.Fatalf("failed to get add method: %s", err)
		}

		sp.Fee = 2000
		sp.FlatFee = true

		if err := atc.AddMethodCall(transaction.AddMethodCallParams{
			AppID:           appID,
			Sender:          sender,
			SuggestedParams: sp,
			OnComplete:      types.NoOpOC,
			Signer:          signer,
			Method:          deleteDataMethod,
			BoxReferences:   []types.AppBoxReference{{AppID: appID, Name: pubKey}, boxIndexRef, boxIndexRef, boxIndexRef, boxIndexRef, boxIndexRef, boxIndexRef, boxIndexRef},
			MethodArgs:      []interface{}{pubKey, boxIndex},
		}); err != nil {
			log.Fatalf("failed to add method call: %s", err)
		}

		dummyMethod, err := contract.GetMethodByName("dummy")
		if err != nil {
			log.Fatalf("failed to get method: %s", err)
		}

		for i := 0; i < 4; i++ {
			if err := atc.AddMethodCall(transaction.AddMethodCallParams{
				AppID:           appID,
				Sender:          sender,
				SuggestedParams: sp,
				OnComplete:      types.NoOpOC,
				Signer:          signer,
				Method:          dummyMethod,
				BoxReferences:   []types.AppBoxReference{boxIndexRef, boxIndexRef, boxIndexRef, boxIndexRef, boxIndexRef, boxIndexRef, boxIndexRef, boxIndexRef},
				MethodArgs:      []interface{}{},
				Note:            []byte(fmt.Sprintf("dummy %d", i)),
			}); err != nil {
				log.Fatalf("failed to add method call: %s", err)
			}
		}

		atcs = append(atcs, struct {
			boxIndex uint64
			atc      transaction.AtomicTransactionComposer
		}{boxIndex, atc})
	}

	for _, atc := range atcs {
		_, err = atc.atc.Execute(algodClient, context.Background(), 3)

		if err != nil {
			log.Fatalf("failed to execute atomic transaction: %s", err)
		}
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

	data := make([]byte, 64_000)
	rand.Read(data)

	UploadDIDDocument(
		algodClient,
		appID,
		contract,
		sender.Address,
		signer,
		data,
		sender.PublicKey,
	)

	fmt.Println(GetMetadata(appID, sender.PublicKey, algodClient))

	DeleteDIDDocument(
		appID,
		sender.PublicKey,
		sender.Address,
		algodClient,
		contract,
		signer,
	)

	// Expect "failed to read metadata box: HTTP 404: {"message":"box not found"}"
	fmt.Println(GetMetadata(appID, sender.PublicKey, algodClient))
}
