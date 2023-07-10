import * as http from "http";
import * as grpc from "@grpc/grpc-js";
import {
  CONTENT_TYPE_HEADER,
  isInvalidVerb,
  isPreflight,
  setCorsHeader,
  setDefaultHeaders,
  setGrpcHeaders,
  WEB_TEXT_HEADER,
} from "./util";
import {
  GrcpServerCallImpl,
  GrcpServerUnaryCallImpl,
  GrpcServerWritableStream,
  GrpcWebHandler,
  GrpcWebWrapper,
  GrpcWebWrapperOptions,
} from "./types";
import { handleServerStream } from "./serverStream";
import { getMockGrpcService } from "./mock/server/service";
import handleUnary from "./unary";
import {
  ServerStreamingHandler,
  UnaryHandler,
} from "@grpc/grpc-js/build/src/server-call";
import { getSerializedMetadata, respondWithStatus } from "./trailers";
import { isString } from "lodash";
import { getDeadlineFromMetadata, getTimeoutinMs } from "./deadline";

/**
 * Handles vaild grpc-web request with grpc.Server and
 * a generic node http.IncomingMessage.
 */
export const grpcWebHandler = (
  grpcServer: grpc.Server,
  req: http.IncomingMessage & { body?: unknown },
  _res: http.ServerResponse<http.IncomingMessage>
) => {
  const res = _res as GrcpServerCallImpl;

  const _body = req.body;

  // body is generated by some frameworks (e.g. Next)
  if (_body && isString(_body)) {
    _grpcWebHandler(grpcServer, req, res, _body);
    return;
  }

  let body = "";

  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    _grpcWebHandler(grpcServer, req, res, body);
  });
};

export const _grpcWebHandler = (
  grpcServer: grpc.Server,
  req: http.IncomingMessage & { body?: unknown },
  res: GrcpServerCallImpl,
  body: string
) => {
  try {
    setGrpcHeaders(res);

    const protocol = req.headers[CONTENT_TYPE_HEADER];

    if (protocol !== WEB_TEXT_HEADER) {
      respondWithStatus(
        res,
        grpc.status.UNIMPLEMENTED,
        "binary wire format not implemented"
      );
      return;
    }

    const buffer = Buffer.from(body, "base64");

    // @ts-ignore -- handlers is a private member of grpc.Server
    const handler: GrpcWebHandler | undefined = grpcServer.handlers.get(
      req.url
    );

    if (!handler) {
      respondWithStatus(
        res,
        grpc.status.UNIMPLEMENTED,
        req.url + " not implemented"
      );
      return;
    }

    // @ts-ignore -- metadata is read only property of ServerCallImpl
    res.metadata = grpc.Metadata.fromHttp2Headers(req.headers);

    // ServerSurfaceCall properties
    res.sendMetadata = (responseMetadata: grpc.Metadata) => {
      try {
        res.write(getSerializedMetadata(responseMetadata));
      } catch (err) {
        console.error(err);
      }
    };

    res.getDeadline = () => getDeadlineFromMetadata(res.metadata);

    res.getPeer = () => res.req.url ?? "";
    res.getPath = () => res.req.url ?? "";

    const timeout = getTimeoutinMs(res.metadata);

    // if theres a timeout, set a timeout to cancel the stream
    // see /grpc-node/packages/grpc-js/src/deadline.ts
    setTimeout(() => {
      respondWithStatus(
        res,
        grpc.status.DEADLINE_EXCEEDED,
        "deadline exceeded: " + timeout + "ms"
      );
    }, timeout);

    if (handler.type === "unary") {
      handleUnary(
        handler as UnaryHandler<any, any>,
        buffer,
        res as GrcpServerUnaryCallImpl
      );
    }

    if (handler.type === "serverStream") {
      handleServerStream(
        handler as ServerStreamingHandler<any, any>,
        buffer,
        res as GrpcServerWritableStream
      );
    }

    return;
  } catch (err) {
    console.error({ err });
    respondWithStatus(res, grpc.status.UNKNOWN, "server error");
  }
};

/**
 * standalone grpc web server
 */
const GrpcWebServer: GrpcWebWrapper = (
  grpcServer: grpc.Server,
  options?: GrpcWebWrapperOptions
) => {
  if (!options) {
    console.log("grpc web starting- no cors set");
  }

  const nodeServer = http.createServer();

  nodeServer.on(
    "request",
    (req: http.IncomingMessage, res: GrcpServerCallImpl) => {
      setDefaultHeaders(res);

      if (options?.cors) {
        setCorsHeader(res, options?.cors);
      }

      if (isPreflight(req, res)) return;
      if (isInvalidVerb(req, res)) return;

      grpcWebHandler(grpcServer, req, res);
    }
  );

  return nodeServer;
};

if (require.main === module) {
  const mockService = getMockGrpcService();

  GrpcWebServer(mockService, { cors: "*" }).listen(1337, () => {
    console.log("started test service");
  });
}

export default GrpcWebServer;
