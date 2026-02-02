const { Pool } = require('pg');

// Kết nối Neon Database
let pool;
let databaseConnected = false;
let initializationAttempted = false;

async function initializeDatabaseWithRetry() {
  if (initializationAttempted && databaseConnected) {
    return true;
  }
  
  initializationAttempted = true;
  const maxRetries = 3;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Database connection attempt ${attempt}/${maxRetries}`);
      
      // Sử dụng NETLIFY_DATABASE_URL thay vì DATABASE_URL
      const databaseUrl = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
      
      if (!databaseUrl) {
        console.log('❌ Database URL not found. Available environment variables:');
        console.log('- NETLIFY_DATABASE_URL:', !!process.env.NETLIFY_DATABASE_URL);
        console.log('- NETLIFY_DATABASE_URL_UNPOOLED:', !!process.env.NETLIFY_DATABASE_URL_UNPOOLED);
        console.log('- DATABASE_URL:', !!process.env.DATABASE_URL);
        return false;
      }

      console.log('📝 Using database URL, length:', databaseUrl.length);
      console.log('🔗 Connection string starts with:', databaseUrl.substring(0, 20) + '...');
      
      // Tạo connection pool - dùng NETLIFY_DATABASE_URL
      pool = new Pool({
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized: false }, // Bắt buộc với Neon
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 5
      });

      // Test connection
      const client = await pool.connect();
      console.log('✅ Database connected successfully');
      
      // Khởi tạo tables
      await initializeTables(client);
      client.release();
      
      databaseConnected = true;
      console.log('✅ Database fully initialized');
      return true;
      
    } catch (error) {
      console.error(`❌ Database attempt ${attempt} failed:`, error.message);
      
      if (pool) {
        try {
          await pool.end();
        } catch (e) {
          console.error('Error closing pool:', e);
        }
        pool = null;
      }
      
      if (attempt < maxRetries) {
        console.log(`⏳ Retrying in 2s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  console.log('❌ All database connection attempts failed');
  return false;
}

async function initializeTables(client) {
  try {
    // Tạo bảng applications
    await client.query(`
      CREATE TABLE IF NOT EXISTS applications (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        api_key VARCHAR(255) UNIQUE NOT NULL,
        created_by VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tạo bảng keys
    await client.query(`
      CREATE TABLE IF NOT EXISTS keys (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) UNIQUE NOT NULL,
        api VARCHAR(255) NOT NULL,
        prefix VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        hwid TEXT,
        banned BOOLEAN DEFAULT FALSE,
        used BOOLEAN DEFAULT FALSE,
        device_limit INTEGER DEFAULT 1,
        system_info TEXT,
        first_used TIMESTAMP,
        FOREIGN KEY (api) REFERENCES applications(api_key) ON DELETE CASCADE
      )
    `);

    // Tạo bảng supports
    await client.query(`
      CREATE TABLE IF NOT EXISTS supports (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) UNIQUE NOT NULL,
        added_by VARCHAR(255) NOT NULL,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Thêm admin mặc định
    await client.query(`
      INSERT INTO supports (user_id, added_by) 
      VALUES ('23082010', 'system')
      ON CONFLICT (user_id) DO NOTHING
    `);

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Table initialization failed:', error);
    throw error;
  }
}

// Khởi tạo ngay khi load
initializeDatabaseWithRetry().catch(console.error);

const MAIN_ADMIN_ID = '23082010';
const MAX_APPS_FOR_SUPPORT = 20;

exports.handler = async (event, context) => {
  console.log('🔧 Function invoked:', event.httpMethod, event.path);
  
  // Enable CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, PUT, DELETE'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Health check endpoint - hiển thị thông tin database
  if (event.httpMethod === 'GET' && event.path.includes('/health')) {
    const databaseUrl = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    
    const healthStatus = {
      success: true,
      message: 'API Health Check',
      timestamp: new Date().toISOString(),
      environment: {
        netlify_database_url: !!process.env.NETLIFY_DATABASE_URL,
        netlify_database_url_unpooled: !!process.env.NETLIFY_DATABASE_URL_UNPOOLED,
        database_url: !!process.env.DATABASE_URL,
        connection_string_length: databaseUrl ? databaseUrl.length : 0
      },
      database: {
        connected: databaseConnected,
        initialized: initializationAttempted
      },
      version: '2.0.0'
    };
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(healthStatus)
    };
  }

  // Kiểm tra database connection cho các endpoint chính
  if (!databaseConnected || !pool) {
    console.log('🔄 Database not connected, attempting to reconnect...');
    const reconnected = await initializeDatabaseWithRetry();
    
    if (!reconnected) {
      const databaseUrl = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          success: false,
          message: 'Database connection failed',
          details: {
            has_netlify_url: !!process.env.NETLIFY_DATABASE_URL,
            has_netlify_unpooled: !!process.env.NETLIFY_DATABASE_URL_UNPOOLED,
            has_custom_url: !!process.env.DATABASE_URL,
            connection_string: databaseUrl ? '***' + databaseUrl.substring(-20) : 'none'
          },
          timestamp: new Date().toISOString()
        })
      };
    }
  }

  // Check if body exists for POST
  if (event.httpMethod === 'POST' && !event.body) {
    return response(400, { success: false, message: 'No body provided' });
  }

  try {
    // Parse body cho POST requests
    let body = {};
    if (event.body && event.httpMethod === 'POST') {
      try {
        body = JSON.parse(event.body);
      } catch (parseError) {
        return response(400, { success: false, message: 'Invalid JSON body' });
      }
    }

    const { action } = body;

    console.log('🔧 Action received:', action);

    // Xử lý các action
    switch (action) {
      case 'check_support':
        return await handleCheckSupport(body);
      
      case 'test':
        return response(200, { 
          success: true, 
          message: 'API is working with PostgreSQL!',
          timestamp: new Date().toISOString(),
          database: 'connected'
        });

      case 'create_app':
        return await handleCreateApp(body);

      case 'delete_app':
        return await handleDeleteApp(body);

      case 'create_key':
        return await handleCreateKey(body);

      case 'delete_key':
        return await handleDeleteKey(body);

      case 'ban_key':
        return await handleBanKey(body);

      case 'check_key':
        return await handleCheckKey(body);

      case 'reset_hwid':
        return await handleResetHWID(body);

      case 'get_apps':
        return await handleGetApps(body);

      case 'get_my_apps':
        return await handleGetMyApps(body);

      case 'get_keys':
        return await handleGetKeys(body);

      case 'list_keys':
        return await handleListKeys(body);

      case 'add_support':
        return await handleAddSupport(body);

      case 'delete_support':
        return await handleDeleteSupport(body);

      case 'get_supports':
        return await handleGetSupports();

      case 'validate_key':
        return await handleValidateKey(body);

      case 'check_permission':
        return await handleCheckPermission(body);

      default:
        // Default GET response
        if (event.httpMethod === 'GET') {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              message: 'KeyAuth API is running!',
              timestamp: new Date().toISOString(),
              database: databaseConnected ? 'connected' : 'disconnected',
              version: '2.0.0'
            })
          };
        }
        return response(400, { success: false, message: 'Invalid action: ' + action });
    }

  } catch (error) {
    console.error('❌ Handler error:', error);
    return response(500, { 
      success: false, 
      message: 'Server error: ' + error.message,
      timestamp: new Date().toISOString()
    });
  }
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  };
}

// ==================== PERMISSION FUNCTIONS ====================

async function checkIfAdmin(user_id) {
  return user_id === MAIN_ADMIN_ID;
}

async function getUserAppCount(user_id) {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM applications WHERE created_by = $1',
    [user_id]
  );
  return parseInt(result.rows[0].count);
}

async function checkAppPermission(user_id, api_key) {
  // Admin có toàn quyền
  if (user_id === MAIN_ADMIN_ID) {
    return { hasPermission: true, isAdmin: true };
  }

  // Check nếu user là owner của app
  const result = await pool.query(
    'SELECT * FROM applications WHERE api_key = $1 AND created_by = $2',
    [api_key, user_id]
  );
  
  return { 
    hasPermission: result.rows.length > 0, 
    isAdmin: false 
  };
}

// ==================== DATABASE HANDLERS ====================

async function handleCheckSupport(body) {
  const { user_id } = body;
  
  if (!user_id) {
    return response(400, { success: false, message: 'User ID is required' });
  }

  const result = await pool.query('SELECT * FROM supports WHERE user_id = $1', [user_id]);
  return response(200, { 
    success: true, 
    is_support: result.rows.length > 0,
    user: result.rows[0] || null
  });
}

async function handleCheckPermission(body) {
  const { user_id, api } = body;
  
  if (!user_id) {
    return response(400, { success: false, message: 'User ID is required' });
  }

  const permission = await checkAppPermission(user_id, api);
  const appCount = await getUserAppCount(user_id);
  const isAdmin = await checkIfAdmin(user_id);
  
  return response(200, { 
    success: true, 
    has_permission: permission.hasPermission,
    is_admin: isAdmin,
    app_count: appCount,
    max_apps: isAdmin ? 999 : MAX_APPS_FOR_SUPPORT
  });
}

async function handleCreateApp(body) {
  const { app_name, user_id } = body;
  
  if (!app_name) {
    return response(400, { success: false, message: 'App name is required' });
  }

  if (!user_id) {
    return response(400, { success: false, message: 'User ID is required' });
  }

  const api_key = 'api_' + Math.random().toString(36).substr(2, 16);

  try {
    // Check permission và số lượng app
    const isAdmin = await checkIfAdmin(user_id);
    const userAppCount = await getUserAppCount(user_id);
    
    if (!isAdmin && userAppCount >= MAX_APPS_FOR_SUPPORT) {
      return response(200, { 
        success: false, 
        message: `Bạn đã đạt giới hạn ${MAX_APPS_FOR_SUPPORT} applications. Chỉ admin mới có thể tạo thêm.` 
      });
    }

    const existingApp = await pool.query('SELECT * FROM applications WHERE name = $1', [app_name]);
    if (existingApp.rows.length > 0) {
      return response(200, { success: false, message: 'App already exists' });
    }

    await pool.query(
      'INSERT INTO applications (name, api_key, created_by) VALUES ($1, $2, $3)',
      [app_name, api_key, user_id]
    );

    console.log('✅ App created:', app_name, 'by user:', user_id);
    return response(200, { 
      success: true, 
      message: 'App created successfully',
      api_key: api_key 
    });
  } catch (error) {
    if (error.code === '23505') {
      return response(200, { success: false, message: 'App already exists' });
    }
    throw error;
  }
}

async function handleCreateKey(body) {
  const { api, prefix, days, device_limit, user_id } = body;
  
  if (!api || !prefix || !days || !user_id) {
    return response(400, { success: false, message: 'Missing required fields: api, prefix, days, user_id' });
  }

  // Check permission
  const permission = await checkAppPermission(user_id, api);
  if (!permission.hasPermission) {
    return response(403, { success: false, message: 'Bạn không có quyền tạo key cho application này' });
  }

  const keyString = `${prefix}-${generateKey()}`;
  const expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const deviceLimit = parseInt(device_limit) || 1;

  // Check if app exists
  const appResult = await pool.query('SELECT * FROM applications WHERE api_key = $1', [api]);
  if (appResult.rows.length === 0) {
    return response(200, { success: false, message: 'Invalid API' });
  }

  await pool.query(
    `INSERT INTO keys (key, api, prefix, expires_at, device_limit) 
     VALUES ($1, $2, $3, $4, $5)`,
    [keyString, api, prefix, expires_at, deviceLimit]
  );

  console.log('✅ Key created:', keyString);
  return response(200, { 
    success: true, 
    message: 'Key created successfully',
    key: keyString 
  });
}

async function handleGetApps(body) {
  const { user_id } = body;
  
  if (!user_id) {
    return response(400, { success: false, message: 'User ID is required' });
  }

  const isAdmin = await checkIfAdmin(user_id);

  let result;
  if (isAdmin) {
    // Admin thấy tất cả apps
    result = await pool.query('SELECT * FROM applications ORDER BY created_at DESC');
  } else {
    // Support chỉ thấy apps của mình
    result = await pool.query(
      'SELECT * FROM applications WHERE created_by = $1 ORDER BY created_at DESC',
      [user_id]
    );
  }
  
  return response(200, { 
    success: true, 
    applications: result.rows,
    is_admin: isAdmin
  });
}

async function handleGetMyApps(body) {
  const { user_id } = body;
  
  if (!user_id) {
    return response(400, { success: false, message: 'User ID is required' });
  }

  const result = await pool.query(
    'SELECT * FROM applications WHERE created_by = $1 ORDER BY created_at DESC',
    [user_id]
  );
  
  return response(200, { 
    success: true, 
    applications: result.rows 
  });
}

async function handleDeleteApp(body) {
  const { app_name, user_id } = body;
  
  if (!app_name || !user_id) {
    return response(400, { success: false, message: 'App name and User ID are required' });
  }

  // Check permission
  const appResult = await pool.query('SELECT * FROM applications WHERE name = $1', [app_name]);
  if (appResult.rows.length === 0) {
    return response(200, { success: false, message: 'App not found' });
  }

  const app = appResult.rows[0];
  const isAdmin = await checkIfAdmin(user_id);
  
  if (!isAdmin && app.created_by !== user_id) {
    return response(403, { success: false, message: 'Bạn không có quyền xóa application này' });
  }

  await pool.query('DELETE FROM applications WHERE name = $1', [app_name]);
  return response(200, { success: true, message: 'App deleted successfully' });
}

async function handleDeleteKey(body) {
  const { api, key, user_id } = body;
  
  if (!api || !key || !user_id) {
    return response(400, { success: false, message: 'API, Key and User ID are required' });
  }

  // Check permission
  const permission = await checkAppPermission(user_id, api);
  if (!permission.hasPermission) {
    return response(403, { success: false, message: 'Bạn không có quyền xóa key của application này' });
  }

  const result = await pool.query(
    'DELETE FROM keys WHERE key = $1 AND api = $2 RETURNING *',
    [key, api]
  );
  
  if (result.rows.length === 0) {
    return response(200, { success: false, message: 'Key not found' });
  }
  
  return response(200, { success: true, message: 'Key deleted successfully' });
}

async function handleBanKey(body) {
  const { api, key, user_id } = body;
  
  if (!api || !key || !user_id) {
    return response(400, { success: false, message: 'API, Key and User ID are required' });
  }

  // Check permission
  const permission = await checkAppPermission(user_id, api);
  if (!permission.hasPermission) {
    return response(403, { success: false, message: 'Bạn không có quyền ban key của application này' });
  }

  const result = await pool.query(
    'UPDATE keys SET banned = true WHERE key = $1 AND api = $2 RETURNING *',
    [key, api]
  );
  
  if (result.rows.length === 0) {
    return response(200, { success: false, message: 'Key not found' });
  }
  
  return response(200, { success: true, message: 'Key banned successfully' });
}

async function handleCheckKey(body) {
  const { api, key, user_id } = body;
  
  if (!api || !key || !user_id) {
    return response(400, { success: false, message: 'API, Key and User ID are required' });
  }

  // Check permission
  const permission = await checkAppPermission(user_id, api);
  if (!permission.hasPermission) {
    return response(403, { success: false, message: 'Bạn không có quyền xem key của application này' });
  }

  const result = await pool.query(
    'SELECT * FROM keys WHERE key = $1 AND api = $2',
    [key, api]
  );
  
  if (result.rows.length === 0) {
    return response(200, { success: false, message: 'Key not found' });
  }
  
  return response(200, { 
    success: true, 
    message: 'Key information',
    key: result.rows[0] 
  });
}

async function handleResetHWID(body) {
  const { api, key, user_id } = body;
  
  if (!api || !key || !user_id) {
    return response(400, { success: false, message: 'API, Key and User ID are required' });
  }

  // Check permission
  const permission = await checkAppPermission(user_id, api);
  if (!permission.hasPermission) {
    return response(403, { success: false, message: 'Bạn không có quyền reset HWID của application này' });
  }

  const result = await pool.query(
    `UPDATE keys SET hwid = NULL, used = false, system_info = NULL, first_used = NULL 
     WHERE key = $1 AND api = $2 RETURNING *`,
    [key, api]
  );
  
  if (result.rows.length === 0) {
    return response(200, { success: false, message: 'Key not found' });
  }
  
  return response(200, { success: true, message: 'HWID reset successfully' });
}

async function handleListKeys(body) {
  const { api, user_id } = body;
  
  if (!api || !user_id) {
    return response(400, { success: false, message: 'API and User ID are required' });
  }

  // Check permission
  const permission = await checkAppPermission(user_id, api);
  if (!permission.hasPermission) {
    return response(403, { success: false, message: 'Bạn không có quyền xem keys của application này' });
  }

  const result = await pool.query(
    `SELECT key, used, banned, expires_at, created_at, hwid 
     FROM keys WHERE api = $1 ORDER BY created_at DESC`,
    [api]
  );
  
  return response(200, { 
    success: true, 
    keys: result.rows 
  });
}

async function handleGetKeys(body) {
  const { api, user_id } = body;
  
  if (!api || !user_id) {
    return response(400, { success: false, message: 'API and User ID are required' });
  }

  // Check permission
  const permission = await checkAppPermission(user_id, api);
  if (!permission.hasPermission) {
    return response(403, { success: false, message: 'Bạn không có quyền xem keys của application này' });
  }

  const result = await pool.query(
    'SELECT * FROM keys WHERE api = $1 ORDER BY created_at DESC',
    [api]
  );
  
  return response(200, { 
    success: true, 
    keys: result.rows 
  });
}

async function handleAddSupport(body) {
  const { user_id, admin_id } = body;
  
  if (!user_id || !admin_id) {
    return response(400, { success: false, message: 'User ID and Admin ID are required' });
  }

  // Check if admin has permission
  const isAdmin = await checkIfAdmin(admin_id);
  if (!isAdmin) {
    return response(403, { success: false, message: 'Chỉ admin mới có thể thêm support' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO supports (user_id, added_by) VALUES ($1, $2) RETURNING *',
      [user_id, admin_id]
    );
    
    return response(200, { 
      success: true, 
      message: 'Support user added successfully',
      support: result.rows[0] 
    });
  } catch (error) {
    if (error.code === '23505') {
      return response(200, { success: false, message: 'User is already a support' });
    }
    throw error;
  }
}

async function handleDeleteSupport(body) {
  const { user_id, admin_id } = body;
  
  if (!user_id || !admin_id) {
    return response(400, { success: false, message: 'User ID and Admin ID are required' });
  }

  // Check if admin has permission
  const isAdmin = await checkIfAdmin(admin_id);
  if (!isAdmin) {
    return response(403, { success: false, message: 'Chỉ admin mới có thể xóa support' });
  }

  if (user_id === MAIN_ADMIN_ID) {
    return response(400, { success: false, message: 'Cannot delete main admin' });
  }

  const result = await pool.query(
    'DELETE FROM supports WHERE user_id = $1 RETURNING *',
    [user_id]
  );
  
  if (result.rows.length === 0) {
    return response(200, { success: false, message: 'Support user not found' });
  }
  
  return response(200, { success: true, message: 'Support user deleted successfully' });
}

async function handleGetSupports() {
  const result = await pool.query('SELECT * FROM supports ORDER BY added_at DESC');
  return response(200, { 
    success: true, 
    supports: result.rows 
  });
}

async function handleValidateKey(body) {
  const { api, key, hwid, system_info } = body;

  if (!api || !key || !hwid) {
    return response(400, { success: false, message: 'API, Key, HWID are required' });
  }

  // Check app
  const appResult = await pool.query(
    'SELECT * FROM applications WHERE api_key = $1',
    [api]
  );
  if (appResult.rows.length === 0) {
    return response(200, { success: false, message: 'Invalid API' });
  }

  // Check key
  const keyResult = await pool.query(
    'SELECT * FROM keys WHERE key = $1 AND api = $2',
    [key, api]
  );
  if (keyResult.rows.length === 0) {
    return response(200, { success: false, message: 'Invalid key' });
  }

  const k = keyResult.rows[0];

  if (k.banned) {
    return response(200, { success: false, message: 'Key banned' });
  }

  // Expiration
  const now = new Date();
  const expires = new Date(k.expires_at);
  if (now > expires) {
    return response(200, { success: false, message: 'Key expired' });
  }

  // =========================
  // 🔐 MULTI DEVICE LOGIC
  // =========================

  let hwids = [];
  if (k.hwid) {
    try {
      hwids = JSON.parse(k.hwid);
    } catch {
      hwids = [];
    }
  }

  // HWID đã tồn tại → cho qua
  if (hwids.includes(hwid)) {
    return response(200, { success: true, message: 'Valid key' });
  }

  // Quá giới hạn thiết bị
  const limit = k.device_limit || 1;
  if (hwids.length >= limit) {
    return response(200, { success: false, message: 'Key limited' });
  }

  // Thêm thiết bị mới
  hwids.push(hwid);

  await pool.query(
    `UPDATE keys 
     SET hwid = $1,
         used = true,
         system_info = $2,
         first_used = COALESCE(first_used, CURRENT_TIMESTAMP)
     WHERE key = $3 AND api = $4`,
    [JSON.stringify(hwids), system_info, key, api]
  );

  return response(200, { success: true, message: 'Valid key' });
}

// ==================== UTILITY FUNCTIONS ====================

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}