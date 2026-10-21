describe('otel startup bootstrap', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('invokes shared OTel initialization for entrypoint startup', () => {
    const initializeOTel = jest.fn().mockResolvedValue(null);

    jest.doMock('../server/utils/otel-setup.js', () => ({
      initializeOTel,
    }));

    require('../server/utils/otel-startup.js');

    expect(initializeOTel).toHaveBeenCalledTimes(1);
  });
});
