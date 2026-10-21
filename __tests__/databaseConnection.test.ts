describe('Database Connection URL Decoding', () => {
  it('should properly decode password with + character', () => {
    const url = 'postgresql://user:pass%2Bword@localhost:5432/mydb';
    const u = new URL(url);
    expect(decodeURIComponent(u.password)).toBe('pass+word');
  });

  it('should properly decode password with / character', () => {
    const url = 'postgresql://user:pass%2Fword@localhost:5432/mydb';
    const u = new URL(url);
    expect(decodeURIComponent(u.password)).toBe('pass/word');
  });

  it('should properly decode password with = character', () => {
    const url = 'postgresql://user:pass%3Dword@localhost:5432/mydb';
    const u = new URL(url);
    expect(decodeURIComponent(u.password)).toBe('pass=word');
  });

  it('should handle unescaped baseline password', () => {
    const url = 'postgresql://user:simplepassword@localhost:5432/mydb';
    const u = new URL(url);
    expect(decodeURIComponent(u.password)).toBe('simplepassword');
  });

  it('should properly decode username', () => {
    const url = 'postgresql://user%40domain:password@localhost:5432/mydb';
    const u = new URL(url);
    expect(decodeURIComponent(u.username)).toBe('user@domain');
  });

  it('should properly decode database name', () => {
    const url = 'postgresql://user:password@localhost:5432/my%2Fdb';
    const u = new URL(url);
    expect(decodeURIComponent(u.pathname.slice(1))).toBe('my/db');
  });

  it('should extract host and port correctly', () => {
    const url = 'postgresql://user:password@localhost:5432/mydb';
    const u = new URL(url);
    expect(u.hostname).toBe('localhost');
    expect(Number(u.port) || 5432).toBe(5432);
  });

  it('should handle missing port (default to 5432)', () => {
    const url = 'postgresql://user:password@localhost/mydb';
    const u = new URL(url);
    expect(u.hostname).toBe('localhost');
    expect(Number(u.port) || 5432).toBe(5432);
  });

  it('should build complete connection options correctly', () => {
    const databaseUrl =
      'postgresql://testuser:pass%3Dword@db.example.com:5433/testdb';
    const u = new URL(databaseUrl);

    const options = {
      host: u.hostname,
      port: Number(u.port) || 5432,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.slice(1)),
    };

    expect(options).toEqual({
      host: 'db.example.com',
      port: 5433,
      user: 'testuser',
      password: 'pass=word',
      database: 'testdb',
    });
  });
});
