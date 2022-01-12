require("dotenv").config()

const path = require("path")
const grpc = require("grpc")
const protoLoader = require("@grpc/proto-loader")
const ProtoBuf = require("protobufjs")
const { createDfuseClient } = require("@dfuse/client")
const { keccak256 } = require("@ethersproject/keccak256")
const { toUtf8Bytes } = require("@ethersproject/strings")

// Global required by dfuse client, only `node-fetch` is used actually
global.fetch = require("node-fetch")
global.WebSocket = require("ws")

const PROTO_DIR = path.join(__dirname, "..", "proto")

const bstreamProto = loadProto("dfuse/bstream/v1/bstream.proto")
const ethProto = loadProto("dfuse/ethereum/codec/v1/codec.proto")

const bstreamService = loadGrpcPackageDefinition("dfuse/bstream/v1/bstream.proto").dfuse.bstream.v1

const blockMsg = bstreamProto.root.lookupType("dfuse.bstream.v1.Block")
const blockDetailsEnum = bstreamProto.root.lookupEnum("dfuse.bstream.v1.BlockDetails")
const ethBlockMsg = ethProto.root.lookupType("dfuse.ethereum.codec.v1.Block")

const blockDetailsLight = blockDetailsEnum.values["BLOCK_DETAILS_LIGHT"]
const blockDetailsFull = blockDetailsEnum.values["BLOCK_DETAILS_FULL"]

async function main() {
  const dfuse = createDfuseClient({
    apiKey: process.env.API_KEY,
    network: process.env.API_ENDPOINT.replace(/:[0-9]+$/, ""),
  })

  const client = new bstreamService.BlockStreamV2(
    process.env.API_ENDPOINT,
    grpc.credentials.createSsl()
  )
  const showFull = true

  const transfer = keccak256(toUtf8Bytes("Transfer(address,address,uint256)")).substring(2)
  const transferSingle = keccak256(
    toUtf8Bytes("TransferSingle(address,address,address,uint256,uint256)")
  ).substring(2)
  const transferBatch = keccak256(
    toUtf8Bytes("TransferBatch(address,address,address,uint256[],uint256[])")
  ).substring(2)

  console.log("TRANSFER TOPIC", transfer)
  console.log("TRANSFER SINGLE TOPIC", transferSingle)
  console.log("TRANSFER BATCH TOPIC", transferBatch)

  const topicMatches = (topic) =>
    topic === transfer || topic === transferSingle || topic === transferBatch
  const callContainsMatchingTopic = (call) =>
    call.logs.find((log) => log.topics.find((topic) => topicMatches(topic.toString("hex"))))

  try {
    await new Promise(async (resolve, reject) => {
      let stream

      try {
        const metadata = new grpc.Metadata()
        metadata.set("authorization", (await dfuse.getTokenInfo()).token)

        stream = client.Blocks(
          {
            start_block_num: 12400000,
            stop_block_num: 12400005,
            details: blockDetailsFull,
          },
          metadata
        )

        stream.on("data", (data) => {
          const { block: rawBlock } = data
          if (rawBlock.type_url !== "type.googleapis.com/sf.ethereum.codec.v1.Block") {
            rejectStream(stream, reject, invalidTypeError(rawBlock.type_url))
            return
          }

          switch (data.step) {
            case "STEP_NEW":
              // Block is the new head block of the chain
              break
            case "STEP_UNDO":
              // Block has been forked out, should undo everything
              break
            case "STEP_IRREVERSIBLE":
              // Block is now irreversible, it's number will be ~360 blocks in the past
              break
          }

          const block = ethBlockMsg.decode(rawBlock.value)

          // The `transactionTraces` will contain only transaction that matches your filter expression above
          const transactionCount = block.transactionTraces.length

          let callCount = 0
          let matchingCallCount = 0

          block.transactionTraces.forEach((trace) => {
            trace.calls
              .filter((call) => callContainsMatchingTopic(call))
              .forEach((call) => {
                // Call represents all internal calls of the transaction, the `call.index` with value `1` is the
                // "root" call which has the same input as the transaction.
                //
                // @see https://github.com/dfuse-io/proto-ethereum/blob/develop/dfuse/ethereum/codec/v1/codec.proto#L196
                callCount += 1

                console.log(
                  "topics",
                  call.logs.map((log) => log.topics.map((topic) => topic.toString("hex")))
                )

                // If the call's field `filteringMatched` is `true`, it means this call matched the filter
                // you used to request the blocks. You can use that to inspect the specific calls that matched
                // your filter.
                if (call.filteringMatched) {
                  matchingCallCount += 1
                }
              })
          })

          console.log(
            `Block #${block.number} (${block.hash.toString(
              "hex"
            )}) - ${transactionCount} Matching Transactions, ${callCount} Calls (${matchingCallCount} matching filter)`
          )
          if (showFull) {
            console.log(JSON.stringify(block, null, "  "))
          }
        })

        stream.on("error", (error) => {
          rejectStream(stream, reject, error)
        })

        stream.on("status", (status) => {
          if (status.code === 0) {
            resolveStream(stream, resolve)
            return
          }

          // On error, I've seen the "error" callback receiving it, so not sure in which case we would do something else here
        })
      } catch (error) {
        if (stream) {
          rejectStream(stream, reject, error)
        } else {
          reject(error)
        }
      }
    })
  } finally {
    // Clean up resources, should be performed only if the gRPC client (`client` here) and/or the dfuse client
    // (`dfuse` here) are not needed anymore. If you have pending stream, you should **not** close those since
    // they are required to make the stream works correctly.
    client.close()
    dfuse.release()
  }
}

function loadGrpcPackageDefinition(package) {
  const protoPath = path.resolve(PROTO_DIR, package)

  const proto = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })

  return grpc.loadPackageDefinition(proto)
}

function loadProto(package) {
  const protoPath = path.resolve(PROTO_DIR, package)

  return ProtoBuf.loadSync(protoPath)
}

function resolveStream(stream, resolver) {
  stream.cancel()
  resolver()
}

function rejectStream(stream, rejection, error) {
  stream.cancel()
  rejection(error)
}

function invalidTypeError(type) {
  return new Error(
    `invalid message type '${type}' received, are you connecting to the right endpoint?`
  )
}

main()
  .then(() => {
    console.log("Completed")
  })
  .catch((error) => {
    console.error("An error occurred", error)
  })
