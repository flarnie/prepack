/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import { BreakpointManager } from "./BreakpointManager.js";
import type { BabelNode, BabelNodeSourceLocation } from "babel-types";
import { Breakpoint } from "./Breakpoint.js";
import invariant from "../invariant.js";
import type { DebugChannel } from "./channel/DebugChannel.js";
import { DebugMessage } from "./channel/DebugMessage.js";
import { DebuggerError } from "./DebuggerError.js";
import type {
  DebuggerRequest,
  StackframeArguments,
  ScopesArguments,
  Stackframe,
  Scope,
  VariablesArguments,
} from "./types.js";
import type { Realm } from "./../realm.js";
import { ExecutionContext } from "./../realm.js";
import { VariableManager } from "./VariableManager.js";
import {
  EnvironmentRecord,
  GlobalEnvironmentRecord,
  FunctionEnvironmentRecord,
  DeclarativeEnvironmentRecord,
  ObjectEnvironmentRecord,
} from "./../environment.js";

export class DebugServer {
  constructor(channel: DebugChannel, realm: Realm) {
    this._breakpoints = new BreakpointManager();
    this._previousExecutedLine = 0;
    this._previousExecutedCol = 0;
    this._lastRunRequestID = 0;
    this._channel = channel;
    this._realm = realm;
    this._variableManager = new VariableManager(realm);
    this.waitForRun();
  }
  // the collection of breakpoints
  _breakpoints: BreakpointManager;
  _previousExecutedFile: void | string;
  _previousExecutedLine: number;
  _previousExecutedCol: number;
  // the channel to communicate with the adapter
  _channel: DebugChannel;
  _lastRunRequestID: number;
  _realm: Realm;
  _variableManager: VariableManager;
  /* Block until adapter says to run
  /* ast: the current ast node we are stopped on
  */
  waitForRun(ast: void | BabelNode) {
    let keepRunning = false;
    let request;
    while (!keepRunning) {
      request = this._channel.readIn();
      keepRunning = this.processDebuggerCommand(request, ast);
    }
  }

  // Checking if the debugger needs to take any action on reaching this ast node
  checkForActions(ast: BabelNode) {
    this.checkForBreakpoint(ast);

    // last step: set the current location as the previously executed line
    if (ast.loc && ast.loc.source !== null) {
      this._previousExecutedFile = ast.loc.source;
      this._previousExecutedLine = ast.loc.start.line;
      this._previousExecutedCol = ast.loc.start.column;
    }
  }

  // Try to find a breakpoint at the given location and check if we should stop on it
  findStoppableBreakpoint(filePath: string, lineNum: number, colNum: number): null | Breakpoint {
    let breakpoint = this._breakpoints.getBreakpoint(filePath, lineNum, colNum);
    if (breakpoint && breakpoint.enabled) {
      // checking if this is the same file and line we stopped at last time
      // if so, we should skip it this time
      // Note: for the case when the debugger is supposed to stop on the same
      // breakpoint consecutively (e.g. the statement is in a loop), some other
      // ast node (e.g. block, loop) must have been checked in between so
      // previousExecutedFile and previousExecutedLine will have changed
      if (breakpoint.column !== 0) {
        // this is a column breakpoint
        if (
          filePath === this._previousExecutedFile &&
          lineNum === this._previousExecutedLine &&
          colNum === this._previousExecutedCol
        ) {
          return null;
        }
      } else {
        // this is a line breakpoint
        if (filePath === this._previousExecutedFile && lineNum === this._previousExecutedLine) {
          return null;
        }
      }
      return breakpoint;
    }
    return null;
  }

  checkForBreakpoint(ast: BabelNode) {
    if (ast.loc && ast.loc.source) {
      let location = ast.loc;
      let filePath = location.source;
      if (filePath === null) return;
      let lineNum = location.start.line;
      let colNum = location.start.column;
      // Check whether there is a breakpoint we need to stop on here
      let breakpoint = this.findStoppableBreakpoint(filePath, lineNum, colNum);
      if (breakpoint === null) return;
      // Tell the adapter that Prepack has stopped on this breakpoint
      this._channel.sendBreakpointStopped(breakpoint.filePath, breakpoint.line, breakpoint.column);
      // Wait for the adapter to tell us to run again
      this.waitForRun(ast);
    }
  }

  // Process a command from a debugger. Returns whether Prepack should unblock
  // if it is blocked
  processDebuggerCommand(request: DebuggerRequest, ast: void | BabelNode) {
    let requestID = request.id;
    let command = request.command;
    let args = request.arguments;
    switch (command) {
      case DebugMessage.BREAKPOINT_ADD_COMMAND:
        invariant(args.kind === "breakpoint");
        this._breakpoints.addBreakpointMulti(args.breakpoints);
        this._channel.sendBreakpointsAcknowledge(DebugMessage.BREAKPOINT_ADD_ACKNOWLEDGE, requestID, args);
        break;
      case DebugMessage.BREAKPOINT_REMOVE_COMMAND:
        invariant(args.kind === "breakpoint");
        this._breakpoints.removeBreakpointMulti(args.breakpoints);
        this._channel.sendBreakpointsAcknowledge(DebugMessage.BREAKPOINT_REMOVE_ACKNOWLEDGE, requestID, args);
        break;
      case DebugMessage.BREAKPOINT_ENABLE_COMMAND:
        invariant(args.kind === "breakpoint");
        this._breakpoints.enableBreakpointMulti(args.breakpoints);
        this._channel.sendBreakpointsAcknowledge(DebugMessage.BREAKPOINT_ENABLE_ACKNOWLEDGE, requestID, args);
        break;
      case DebugMessage.BREAKPOINT_DISABLE_COMMAND:
        invariant(args.kind === "breakpoint");
        this._breakpoints.disableBreakpointMulti(args.breakpoints);
        this._channel.sendBreakpointsAcknowledge(DebugMessage.BREAKPOINT_DISABLE_ACKNOWLEDGE, requestID, args);
        break;
      case DebugMessage.PREPACK_RUN_COMMAND:
        invariant(args.kind === "run");
        this._onDebuggeeResume();
        return true;
      case DebugMessage.STACKFRAMES_COMMAND:
        invariant(args.kind === "stackframe");
        this.processStackframesCommand(requestID, args, ast);
        break;
      case DebugMessage.SCOPES_COMMAND:
        invariant(args.kind === "scopes");
        this.processScopesCommand(requestID, args);
        break;
      case DebugMessage.VARIABLES_COMMAND:
        invariant(args.kind === "variables");
        this.processVariablesCommand(requestID, args);
        break;
      default:
        throw new DebuggerError("Invalid command", "Invalid command from adapter: " + command);
    }
    return false;
  }

  processStackframesCommand(requestID: number, args: StackframeArguments, ast: void | BabelNode) {
    let frameInfos: Array<Stackframe> = [];
    let loc = this._getFrameLocation(ast ? ast.loc : null);
    let fileName = loc.fileName;
    let line = loc.line;
    let column = loc.column;

    // the UI displays the current frame as index 0, so we iterate backwards
    // from the current frame
    for (let i = this._realm.contextStack.length - 1; i >= 0; i--) {
      let frame = this._realm.contextStack[i];
      let functionName = "(anonymous function)";
      if (frame.function && frame.function.__originalName) {
        functionName = frame.function.__originalName;
      }

      let frameInfo: Stackframe = {
        id: this._realm.contextStack.length - 1 - i,
        functionName: functionName,
        fileName: fileName,
        line: line,
        column: column,
      };
      frameInfos.push(frameInfo);
      loc = this._getFrameLocation(frame.loc);
      fileName = loc.fileName;
      line = loc.line;
      column = loc.column;
    }
    this._channel.sendStackframeResponse(requestID, frameInfos);
  }

  _getFrameLocation(loc: void | null | BabelNodeSourceLocation): { fileName: string, line: number, column: number } {
    let fileName = "unknown";
    let line = 0;
    let column = 0;
    if (loc && loc.source) {
      fileName = loc.source;
      line = loc.start.line;
      column = loc.start.column;
    }
    return {
      fileName: fileName,
      line: line,
      column: column,
    };
  }

  processScopesCommand(requestID: number, args: ScopesArguments) {
    // first check that frameId is in the valid range
    if (args.frameId < 0 || args.frameId >= this._realm.contextStack.length) {
      throw new DebuggerError("Invalid command", "Invalid frame id for scopes request: " + args.frameId);
    }
    // here the frameId is in reverse order of the contextStack, ie frameId 0
    // refers to last element of contextStack
    let stackIndex = this._realm.contextStack.length - 1 - args.frameId;
    let context = this._realm.contextStack[stackIndex];
    invariant(context instanceof ExecutionContext);
    let scopes = [];
    let lexicalEnv = context.lexicalEnvironment;
    while (lexicalEnv) {
      let scope: Scope = {
        name: this._getScopeName(lexicalEnv.environmentRecord),
        // key used by UI to retrieve variables in this scope
        variablesReference: this._variableManager.getReferenceForValue(lexicalEnv),
        // the variables are easy to retrieve
        expensive: false,
      };
      scopes.push(scope);
      lexicalEnv = lexicalEnv.parent;
    }
    this._channel.sendScopesResponse(requestID, scopes);
  }

  _getScopeName(envRec: EnvironmentRecord): string {
    if (envRec instanceof GlobalEnvironmentRecord) {
      return "Global";
    } else if (envRec instanceof DeclarativeEnvironmentRecord) {
      if (envRec instanceof FunctionEnvironmentRecord) {
        return "Local: " + (envRec.$FunctionObject.__originalName || "anonymous function");
      } else {
        return "Block";
      }
    } else if (envRec instanceof ObjectEnvironmentRecord) {
      return "With";
    } else {
      invariant(false, "Invalid type of environment record");
    }
  }

  processVariablesCommand(requestID: number, args: VariablesArguments) {
    let variables = this._variableManager.getVariablesByReference(args.variablesReference);
    this._channel.sendVariablesResponse(requestID, variables);
  }

  // actions that need to happen before Prepack can resume
  _onDebuggeeResume() {
    // resets the variable manager
    this._variableManager.clean();
  }

  shutdown() {
    //let the adapter know Prepack is done running
    this._channel.sendPrepackFinish();
  }
}
