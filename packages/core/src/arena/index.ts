// highwire-core/arena: the arena's game, the house, ratings and the table-talk rule. Nothing here may import a Node
// built-in, Raydium's SDK or web3.js: the referee runs it on its own small dependency set (test/arena.test.ts checks).
export * from "./rules.ts";
export * from "./solve.ts";
export * from "./house.ts";
export * from "./glicko.ts";
export * from "./guide.ts";
export { checkTableTalk, TABLE_TALK_MAX } from "../higher/post-text.ts";
export { ValidationError, HigherError } from "../lib/errors.ts";
// The few chain facts the referee checks registrations against.
export { HIGHWIRE_MEMO, MAINNET, MEMO_PROGRAM_ID } from "../higher/constants.ts";
