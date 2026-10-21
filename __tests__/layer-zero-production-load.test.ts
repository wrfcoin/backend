describe('backend#1027 LayerZero production module load', () => {
  it('loads the real router without a test-provided logger or limiter', () => {
    expect(() => require('../server/routes/layer-zero-routes')).not.toThrow();
  });
});
