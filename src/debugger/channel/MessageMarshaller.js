/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */
import { DebugMessage } from "./DebugMessage.js";
import type {
  Breakpoint,
  BreakpointsArguments,
  ScopesArguments,
  Stackframe,
  DebuggerResponse,
  StackframeResult,
  BreakpointsAddResult,
  BreakpointStoppedResult,
  ReadyResult,
  Scope,
  ScopesResult,
  Variable,
  VariablesArguments,
  VariablesResult,
  DebuggerRequest,
  DebuggerRequestArguments,
  RunArguments,
  StackframeArguments,
  FinishResult,
} from "./../types.js";
import invariant from "./../../invariant.js";
import { DebuggerError } from "./../DebuggerError.js";

export class MessageMarshaller {
  constructor() {
    this._lastRunRequestID = 0;
  }
  _lastRunRequestID: number;

  marshallBreakpointAcknowledge(requestID: number, messageType: string, breakpoints: Array<Breakpoint>): string {
    return `${requestID} ${messageType} ${JSON.stringify(breakpoints)}`;
  }

  marshallBreakpointStopped(args: Breakpoint): string {
    return `${this
      ._lastRunRequestID} ${DebugMessage.BREAKPOINT_STOPPED_RESPONSE} ${args.filePath} ${args.line} ${args.column}`;
  }

  marshallPrepackFinish(): string {
    return `${this._lastRunRequestID} ${DebugMessage.PREPACK_FINISH_RESPONSE}`;
  }

  marshallDebuggerStart(requestID: number): string {
    return `${requestID} ${DebugMessage.DEBUGGER_ATTACHED}`;
  }

  marshallContinueRequest(requestID: number): string {
    return `${requestID} ${DebugMessage.PREPACK_RUN_COMMAND}`;
  }

  marshallSetBreakpointsRequest(requestID: number, breakpoints: Array<Breakpoint>): string {
    return `${requestID} ${DebugMessage.BREAKPOINT_ADD_COMMAND} ${JSON.stringify(breakpoints)}`;
  }

  marshallStackFramesRequest(requestID: number): string {
    return `${requestID} ${DebugMessage.STACKFRAMES_COMMAND}`;
  }

  marshallStackFramesResponse(requestID: number, stackframes: Array<Stackframe>): string {
    return `${requestID} ${DebugMessage.STACKFRAMES_RESPONSE} ${JSON.stringify(stackframes)}`;
  }

  marshallScopesRequest(requestID: number, frameId: number): string {
    return `${requestID} ${DebugMessage.SCOPES_COMMAND} ${frameId}`;
  }

  marshallScopesResponse(requestID: number, scopes: Array<Scope>): string {
    return `${requestID} ${DebugMessage.SCOPES_RESPONSE} ${JSON.stringify(scopes)}`;
  }

  marshallVariablesRequest(requestID: number, variablesReference: number): string {
    return `${requestID} ${DebugMessage.VARIABLES_COMMAND} ${variablesReference}`;
  }

  marshallVariablesResponse(requestID: number, variables: Array<Variable>): string {
    return `${requestID} ${DebugMessage.VARIABLES_RESPONSE} ${JSON.stringify(variables)}`;
  }

  unmarshallRequest(message: string): DebuggerRequest {
    let parts = message.split(" ");
    // each request must have a length and a command
    invariant(parts.length >= 2, "Request is not well formed");
    // unique ID for each request
    let requestID = parseInt(parts[0], 10);
    invariant(!isNaN(requestID), "Request ID must be a number");
    let command = parts[1];
    let args: DebuggerRequestArguments;
    switch (command) {
      case DebugMessage.PREPACK_RUN_COMMAND:
        this._lastRunRequestID = requestID;
        let runArgs: RunArguments = {
          kind: "run",
        };
        args = runArgs;
        break;
      case DebugMessage.BREAKPOINT_ADD_COMMAND:
        args = this._unmarshallBreakpointsArguments(requestID, parts.slice(2).join(" "));
        break;
      case DebugMessage.STACKFRAMES_COMMAND:
        let stackFrameArgs: StackframeArguments = {
          kind: "stackframe",
        };
        args = stackFrameArgs;
        break;
      case DebugMessage.SCOPES_COMMAND:
        args = this._unmarshallScopesArguments(requestID, parts[2]);
        break;
      case DebugMessage.VARIABLES_COMMAND:
        args = this._unmarshallVariablesArguments(requestID, parts[2]);
        break;
      default:
        throw new DebuggerError("Invalid command", "Invalid command from adapter: " + command);
    }
    invariant(args !== undefined);
    let result: DebuggerRequest = {
      id: requestID,
      command: command,
      arguments: args,
    };
    return result;
  }

  unmarshallResponse(message: string): DebuggerResponse {
    let parts = message.split(" ");
    let requestID = parseInt(parts[0], 10);
    invariant(!isNaN(requestID));
    let messageType = parts[1];
    let dbgResponse;
    if (messageType === DebugMessage.PREPACK_READY_RESPONSE) {
      dbgResponse = this._unmarshallReadyResponse(requestID);
    } else if (messageType === DebugMessage.BREAKPOINT_ADD_ACKNOWLEDGE) {
      dbgResponse = this._unmarshallBreakpointsAddResponse(requestID, parts.slice(2).join(" "));
    } else if (messageType === DebugMessage.BREAKPOINT_STOPPED_RESPONSE) {
      dbgResponse = this._unmarshallBreakpointStoppedResponse(requestID, parts.slice(2));
    } else if (messageType === DebugMessage.STACKFRAMES_RESPONSE) {
      dbgResponse = this._unmarshallStackframesResponse(requestID, parts.slice(2).join(" "));
    } else if (messageType === DebugMessage.SCOPES_RESPONSE) {
      dbgResponse = this._unmarshallScopesResponse(requestID, parts.slice(2).join(" "));
    } else if (messageType === DebugMessage.VARIABLES_RESPONSE) {
      dbgResponse = this._unmarshallVariablesResponse(requestID, parts.slice(2).join(" "));
    } else if (messageType === DebugMessage.PREPACK_FINISH_RESPONSE) {
      dbgResponse = this._unmarshallFinishResponse(requestID);
    } else {
      invariant(false, "Unexpected response type");
    }
    return dbgResponse;
  }

  _unmarshallBreakpointsArguments(requestID: number, breakpointsString: string): BreakpointsArguments {
    try {
      let breakpoints = JSON.parse(breakpointsString);
      for (const breakpoint of breakpoints) {
        invariant(breakpoint.hasOwnProperty("filePath"), "breakpoint missing filePath property");
        invariant(breakpoint.hasOwnProperty("line"), "breakpoint missing line property");
        invariant(breakpoint.hasOwnProperty("column"), "breakpoint missing column property");
        invariant(!isNaN(breakpoint.line));
        invariant(!isNaN(breakpoint.column));
      }
      let result: BreakpointsArguments = {
        kind: "breakpoint",
        breakpoints: breakpoints,
      };
      return result;
    } catch (e) {
      throw new DebuggerError("Invalid command", e.message);
    }
  }

  _unmarshallScopesArguments(requestID: number, frameIdString: string): ScopesArguments {
    let frameId = parseInt(frameIdString, 10);
    invariant(!isNaN(frameId));
    let result: ScopesArguments = {
      kind: "scopes",
      frameId: frameId,
    };
    return result;
  }

  _unmarshallVariablesArguments(requestID: number, varRefString: string): VariablesArguments {
    let varRef = parseInt(varRefString, 10);
    invariant(!isNaN(varRef));
    let result: VariablesArguments = {
      kind: "variables",
      variablesReference: varRef,
    };
    return result;
  }

  _unmarshallStackframesResponse(requestID: number, responseBody: string): DebuggerResponse {
    try {
      let frames = JSON.parse(responseBody);
      invariant(Array.isArray(frames), "Stack frames is not an array");
      for (const frame of frames) {
        invariant(frame.hasOwnProperty("id"), "Stack frame is missing id");
        invariant(frame.hasOwnProperty("fileName"), "Stack frame is missing filename");
        invariant(frame.hasOwnProperty("line"), "Stack frame is missing line number");
        invariant(frame.hasOwnProperty("column"), "Stack frame is missing column number");
        invariant(frame.hasOwnProperty("functionName"), "Stack frame is missing function name");
      }
      let result: StackframeResult = {
        kind: "stackframe",
        stackframes: frames,
      };
      let dbgResponse: DebuggerResponse = {
        id: requestID,
        result: result,
      };
      return dbgResponse;
    } catch (e) {
      throw new DebuggerError("Invalid response", e.message);
    }
  }

  _unmarshallScopesResponse(requestID: number, responseBody: string): DebuggerResponse {
    try {
      let scopes = JSON.parse(responseBody);
      invariant(Array.isArray(scopes), "Scopes is not an array");
      for (const scope of scopes) {
        invariant(scope.hasOwnProperty("name"), "Scope is missing name");
        invariant(scope.hasOwnProperty("variablesReference"), "Scope is missing variablesReference");
        invariant(scope.hasOwnProperty("expensive"), "Scope is missing expensive");
      }
      let result: ScopesResult = {
        kind: "scopes",
        scopes: scopes,
      };
      let dbgResponse: DebuggerResponse = {
        id: requestID,
        result: result,
      };
      return dbgResponse;
    } catch (e) {
      throw new DebuggerError("Invalid response", e.message);
    }
  }

  _unmarshallVariablesResponse(requestID: number, responseBody: string): DebuggerResponse {
    try {
      let variables = JSON.parse(responseBody);
      invariant(Array.isArray(variables), "Variables is not an array");
      for (const variable of variables) {
        invariant(variable.hasOwnProperty("name"));
        invariant(variable.hasOwnProperty("value"));
        invariant(variable.hasOwnProperty("variablesReference"));
      }
      let result: VariablesResult = {
        kind: "variables",
        variables: variables,
      };
      let dbgResponse: DebuggerResponse = {
        id: requestID,
        result: result,
      };
      return dbgResponse;
    } catch (e) {
      throw new DebuggerError("Invalid response", e.message);
    }
  }

  _unmarshallBreakpointsAddResponse(requestID: number, breakpointsString: string): DebuggerResponse {
    try {
      let breakpoints = JSON.parse(breakpointsString);
      for (const breakpoint of breakpoints) {
        invariant(breakpoint.hasOwnProperty("filePath"), "breakpoint missing filePath property");
        invariant(breakpoint.hasOwnProperty("line"), "breakpoint missing line property");
        invariant(breakpoint.hasOwnProperty("column"), "breakpoint missing column property");
        invariant(!isNaN(breakpoint.line));
        invariant(!isNaN(breakpoint.column));
      }

      let result: BreakpointsAddResult = {
        kind: "breakpoint-add",
        breakpoints: breakpoints,
      };
      let dbgResponse: DebuggerResponse = {
        id: requestID,
        result: result,
      };
      return dbgResponse;
    } catch (e) {
      throw new DebuggerError("Invalid response", e.message);
    }
  }

  _unmarshallBreakpointStoppedResponse(requestID: number, parts: Array<string>): DebuggerResponse {
    invariant(parts.length === 3, "Incorrect number of arguments in breakpoint stopped response");
    let filePath = parts[0];
    let line = parseInt(parts[1], 10);
    invariant(!isNaN(line), "Invalid line number");
    let column = parseInt(parts[2], 10);
    invariant(!isNaN(column), "Invalid column number");
    let result: BreakpointStoppedResult = {
      kind: "breakpoint-stopped",
      filePath: filePath,
      line: line,
      column: column,
    };
    let dbgResponse: DebuggerResponse = {
      id: requestID,
      result: result,
    };
    return dbgResponse;
  }

  _unmarshallReadyResponse(requestID: number): DebuggerResponse {
    let result: ReadyResult = {
      kind: "ready",
    };
    let dbgResponse: DebuggerResponse = {
      id: requestID,
      result: result,
    };
    return dbgResponse;
  }

  _unmarshallFinishResponse(requestID: number): DebuggerResponse {
    let result: FinishResult = {
      kind: "finish",
    };
    let dbgResponse: DebuggerResponse = {
      id: requestID,
      result: result,
    };
    return dbgResponse;
  }
}
