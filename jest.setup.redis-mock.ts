import redis from "./test/redisV4Mock";
jest.mock("redis", () => redis);