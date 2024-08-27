module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	testMatch: ['**/test/test.ts'],
	setupFilesAfterEnv: ['./jest.setup.redis-mock.ts']
};