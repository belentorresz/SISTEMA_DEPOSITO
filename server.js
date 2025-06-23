const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const cors = require('cors');

// Configuración inicial
const app = express();

// Configuración CORS
const corsOptions = {
    origin: ['http://localhost', 'http://localhost:5500', 'http://127.0.0.1:5500'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Middlewares
app.use(bodyParser.json({
    limit: '10mb',
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));

app.use(bodyParser.urlencoded({
    extended: true,
    limit: '10mb'
}));

// Configuración de PostgreSQL
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'tlacomp',
    password: 'root',
    port: 5432,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});

// Verificación de conexión
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Error de conexión a PostgreSQL:', err.stack);
        process.exit(1);
    } else {
        console.log('✅ PostgreSQL conectado. Hora actual:', res.rows[0].now);
    }
});

// Middleware de logging
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.originalUrl}`);
    if (req.body && Object.keys(req.body).length > 0) {
        console.log('📦 Body:', JSON.stringify(req.body, null, 2));
    }
    next();
});

// Health Check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        database: 'Connected',
        timestamp: new Date(),
        uptime: process.uptime()
    });
});

// Ruta para registro de clientes
app.post('/registrar-cliente', async (req, res) => {
    // Verificar que todos los campos requeridos están presentes
    const requiredFields = [
        'nombres', 'apellidos', 'tipoDocumento', 
        'numeroDocumento', 'email', 'password'
    ];
    
    const missingFields = requiredFields.filter(field => !req.body[field]);
    
    if (missingFields.length > 0) {
        console.error('Campos faltantes:', missingFields);
        return res.status(400).json({
            success: false,
            error: 'Faltan campos obligatorios',
            missingFields: missingFields
        });
    }

    // Validar formato de contraseña
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[._!#$%&/]).{8,}$/;
    if (!passwordRegex.test(req.body.password)) {
        return res.status(400).json({
            success: false,
            error: 'La contraseña debe tener al menos 8 caracteres, incluyendo mayúsculas, minúsculas, números y un caracter especial (. _ ! # $ % & /)'
        });
    }

    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO mae_clientes 
            (nombres, apellidos, tipo_documento, dni, email, celular, direccion, contrasena)
            VALUES ($1, $2, $3, $4, $5, $6, $7, crypt($8, gen_salt('bf')))
            RETURNING id, nombres, apellidos, dni, email, celular, direccion`;
        
        const result = await client.query(query, [
            req.body.nombres,
            req.body.apellidos,
            req.body.tipoDocumento,
            req.body.numeroDocumento,
            req.body.email,
            req.body.celular || null,
            req.body.direccion || null,
            req.body.password
        ]);
        
        res.json({
            success: true,
            usuario: result.rows[0],
            redirect: '/seleccionar-cuenta.html'
        });
    } catch (error) {
        console.error('Error al registrar cliente:', error);
        
        let errorMsg = 'Error al registrar usuario';
        if (error.code === '23505') { // Violación de unique constraint
            if (error.constraint.includes('dni')) {
                errorMsg = 'El número de documento ya está registrado';
            } else if (error.constraint.includes('email')) {
                errorMsg = 'El email ya está registrado';
            }
        }
        
        res.status(500).json({
            success: false,
            error: errorMsg,
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        client.release();
    }
});

// Ruta para login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email y contraseña son requeridos' 
        });
    }

    const client = await pool.connect();
    try {
        // 1. Verificar credenciales
        const queryUsuario = `
            SELECT id, nombres, apellidos, dni, email, celular, direccion 
            FROM mae_clientes 
            WHERE email = $1 AND contrasena = crypt($2, contrasena)`;
        
        const resultUsuario = await client.query(queryUsuario, [email, password]);
        
        if (resultUsuario.rows.length === 0) {
            return res.status(401).json({ 
                success: false, 
                error: 'Credenciales incorrectas' 
            });
        }
        
        // 2. Obtener cuentas asociadas
        const queryCuentas = `
            SELECT id, numero_cuenta, tipo_moneda, saldo, fecha_creacion 
            FROM mae_cuentas 
            WHERE dni_titular = $1
            ORDER BY tipo_moneda DESC, fecha_creacion DESC`;
            
        const resultCuentas = await client.query(queryCuentas, [resultUsuario.rows[0].dni]);
        
        // 3. Preparar respuesta
        const usuario = {
            ...resultUsuario.rows[0],
            cuentas: resultCuentas.rows
        };
        
        res.json({ 
            success: true,
            usuario: usuario,
            redirect: '/perfil.html'
        });
        
    } catch (error) {
        console.error('❌ Error en login:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: 'Error en el servidor',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        client.release();
    }
});

// Ruta para creación de cuentas
app.post('/api/crear-cuentas', async (req, res) => {
    console.log("📥 Solicitud crear-cuentas recibida:", req.body);
    
    const { dni, cuentaSoles, cuentaDolares } = req.body;
    
    if (!dni) {
        return res.status(400).json({ 
            success: false, 
            error: 'DNI es requerido' 
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const cuentasCreadas = [];
        const errors = [];
        
        // Crear cuenta en Soles si fue seleccionada
        if (cuentaSoles) {
            try {
                const numeroCuenta = generarNumeroCuenta('PEN');
                console.log(`🔄 Creando cuenta PEN: ${numeroCuenta}`);
                
                const result = await client.query(
                    `INSERT INTO mae_cuentas (numero_cuenta, dni_titular, tipo_moneda, saldo)
                     VALUES ($1, $2, 'PEN', 0)
                     RETURNING id, numero_cuenta, tipo_moneda, saldo`,
                    [numeroCuenta, dni]
                );
                cuentasCreadas.push(result.rows[0]);
            } catch (error) {
                console.error('⚠️ Error creando cuenta PEN:', error.message);
                errors.push('Error creando cuenta en Soles');
            }
        }
        
        // Crear cuenta en Dólares si fue seleccionada
        if (cuentaDolares) {
            try {
                const numeroCuenta = generarNumeroCuenta('USD');
                console.log(`🔄 Creando cuenta USD: ${numeroCuenta}`);
                
                const result = await client.query(
                    `INSERT INTO mae_cuentas (numero_cuenta, dni_titular, tipo_moneda, saldo)
                     VALUES ($1, $2, 'USD', 0)
                     RETURNING id, numero_cuenta, tipo_moneda, saldo`,
                    [numeroCuenta, dni]
                );
                cuentasCreadas.push(result.rows[0]);
            } catch (error) {
                console.error('⚠️ Error creando cuenta USD:', error.message);
                errors.push('Error creando cuenta en Dólares');
            }
        }
        
        // Verificar si se creó al menos una cuenta
        if (cuentasCreadas.length === 0) {
            await client.query('ROLLBACK');
            const errorMsg = errors.length > 0 ? errors.join(' | ') : 'Debes seleccionar al menos un tipo de cuenta';
            return res.status(400).json({
                success: false,
                error: errorMsg
            });
        }

        // Obtener datos actualizados del usuario
        const usuario = await client.query(
            'SELECT id, nombres, apellidos, dni, email FROM mae_clientes WHERE dni = $1', 
            [dni]
        );

        await client.query('COMMIT');
        
        console.log(`✅ Cuentas creadas para DNI ${dni}:`, cuentasCreadas);
        res.json({
            success: true,
            usuario: usuario.rows[0],
            cuentas: cuentasCreadas,
            warnings: errors.length > 0 ? errors : undefined
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error en transacción crear-cuentas:', error.stack);
        res.status(500).json({
            success: false,
            error: 'Error al procesar la solicitud',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        client.release();
    }
});

// Ruta para obtener cuentas de usuario
app.get('/api/cuentas-usuario', async (req, res) => {
    const { dni } = req.query;
    
    if (!dni) {
        return res.status(400).json({
            success: false,
            error: 'DNI es requerido'
        });
    }

    const client = await pool.connect();
    try {
        const query = `
            SELECT id, numero_cuenta, tipo_moneda, saldo, fecha_creacion
            FROM mae_cuentas 
            WHERE dni_titular = $1
            ORDER BY tipo_moneda DESC, fecha_creacion DESC`;
            
        const result = await client.query(query, [dni]);
        
        res.json({
            success: true,
            cuentas: result.rows
        });
        
    } catch (error) {
        console.error('❌ Error al obtener cuentas:', error.stack);
        res.status(500).json({
            success: false,
            error: 'Error al obtener cuentas',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        client.release();
    }
});

// Ruta para verificar cuenta
app.get('/api/verificar-cuenta', async (req, res) => {
    const { numero } = req.query;
    
    if (!numero) {
        return res.status(400).json({
            success: false,
            error: 'Número de cuenta es requerido'
        });
    }

    const client = await pool.connect();
    try {
        const query = `
            SELECT c.*, cl.nombres, cl.apellidos 
            FROM mae_cuentas c
            JOIN mae_clientes cl ON c.dni_titular = cl.dni
            WHERE c.numero_cuenta = $1`;
            
        const result = await client.query(query, [numero]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Cuenta no encontrada'
            });
        }
        
        res.json({
            success: true,
            cuenta: result.rows[0],
            cliente: {
                nombres: result.rows[0].nombres,
                apellidos: result.rows[0].apellidos,
                dni: result.rows[0].dni_titular
            }
        });
        
    } catch (error) {
        console.error('Error al verificar cuenta:', error.stack);
        res.status(500).json({
            success: false,
            error: 'Error al verificar cuenta'
        });
    } finally {
        client.release();
    }
});

// Ruta para realizar depósito
app.post('/api/realizar-deposito', async (req, res) => {
    const { 
        numero_cuenta, 
        monto_origen, 
        moneda_origen,
        moneda_destino,
        tipo_cambio = 3.80,
        metodo_pago, 
        fecha
    } = req.body;
    
    // Validación de campos obligatorios
    const requiredFields = ['numero_cuenta', 'monto_origen', 'moneda_origen', 'moneda_destino', 'metodo_pago'];
    const missingFields = requiredFields.filter(field => !req.body[field]);
    
    if (missingFields.length > 0) {
        return res.status(400).json({
            success: false,
            error: 'Faltan campos obligatorios',
            missingFields: missingFields
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Verificar y bloquear la cuenta
        const cuentaResult = await client.query(
            'SELECT id, saldo, tipo_moneda FROM mae_cuentas WHERE numero_cuenta = $1 FOR UPDATE',
            [numero_cuenta]
        );
        
        if (cuentaResult.rows.length === 0) {
            throw new Error('La cuenta no existe');
        }
        
        const cuenta = cuentaResult.rows[0];
        
        // 2. Validar que la moneda destino coincida con la cuenta
        if (cuenta.tipo_moneda !== moneda_destino) {
            throw new Error('La moneda de destino no coincide con la cuenta');
        }
        
        // 3. Calcular monto convertido
        let montoConvertido;
        if (moneda_origen === moneda_destino) {
            // Misma moneda - sin conversión
            montoConvertido = parseFloat(monto_origen);
        } else if (moneda_origen === 'PEN' && moneda_destino === 'USD') {
            // Soles a Dólares
            montoConvertido = parseFloat(monto_origen) / parseFloat(tipo_cambio);
        } else if (moneda_origen === 'USD' && moneda_destino === 'PEN') {
            // Dólares a Soles
            montoConvertido = parseFloat(monto_origen) * parseFloat(tipo_cambio);
        } else {
            throw new Error('Conversión de moneda no soportada');
        }
        
        // 4. Calcular nuevo saldo
        const nuevoSaldo = parseFloat(cuenta.saldo) + montoConvertido;
        
        // 5. Actualizar saldo
        await client.query(
            'UPDATE mae_cuentas SET saldo = $1 WHERE id = $2',
            [nuevoSaldo.toFixed(2), cuenta.id]
        );
        
        // 6. Registrar movimiento
        await client.query(
            `INSERT INTO mae_movimientos (cuenta_id, tipo, monto, saldo_final, metodo_pago, fecha, descripcion)
             VALUES ($1, 'DEPOSITO', $2, $3, $4, $5, $6)`,
            [
                cuenta.id, 
                montoConvertido.toFixed(2),
                nuevoSaldo.toFixed(2),
                metodo_pago, 
                fecha,
                `Depósito de ${moneda_origen} a ${moneda_destino} (TC: ${tipo_cambio})`
            ]
        );
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            saldo_actual: nuevoSaldo.toFixed(2),
            monto_convertido: montoConvertido.toFixed(2),
            tipo_moneda_destino: moneda_destino,
            mensaje: 'Depósito realizado con éxito'
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al realizar depósito:', error.stack);
        res.status(500).json({
            success: false,
            error: error.message || 'Error al realizar el depósito'
        });
    } finally {
        client.release();
    }
});


// Ruta para actualizar usuario
app.post('/api/actualizar-usuario', async (req, res) => {
    const { dni, nombres, apellidos, direccion, celular, contrasena } = req.body;
    
    if (!dni) {
        return res.status(400).json({
            success: false,
            error: 'DNI es requerido'
        });
    }

    const client = await pool.connect();
    try {
        let query;
        let params;
        
        if (contrasena) {
            query = `
                UPDATE mae_clientes 
                SET nombres = $1, apellidos = $2, direccion = $3, celular = $4, 
                    contrasena = crypt($5, gen_salt('bf'))
                WHERE dni = $6
                RETURNING id, nombres, apellidos, dni, email, celular, direccion`;
            params = [nombres, apellidos, direccion, celular, contrasena, dni];
        } else {
            query = `
                UPDATE mae_clientes 
                SET nombres = $1, apellidos = $2, direccion = $3, celular = $4
                WHERE dni = $5
                RETURNING id, nombres, apellidos, dni, email, celular, direccion`;
            params = [nombres, apellidos, direccion, celular, dni];
        }
        
        const result = await client.query(query, params);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Usuario no encontrado'
            });
        }
        
        // Obtener cuentas actualizadas
        const queryCuentas = `
            SELECT id, numero_cuenta, tipo_moneda, saldo 
            FROM mae_cuentas 
            WHERE dni_titular = $1`;
        const resultCuentas = await client.query(queryCuentas, [dni]);
        
        const usuarioActualizado = {
            ...result.rows[0],
            cuentas: resultCuentas.rows
        };
        
        res.json({
            success: true,
            usuario: usuarioActualizado
        });
        
    } catch (error) {
        console.error('❌ Error al actualizar usuario:', error.stack);
        res.status(500).json({
            success: false,
            error: 'Error al actualizar datos',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        client.release();
    }
});

// Ruta para obtener movimientos de una cuenta
app.get('/api/movimientos-cuenta', async (req, res) => {
    const { cuenta_id } = req.query;
    
    if (!cuenta_id) {
        return res.status(400).json({
            success: false,
            error: 'ID de cuenta es requerido'
        });
    }

    const client = await pool.connect();
    try {
        const query = `
            SELECT 
                m.id,
                m.tipo,
                m.monto,
                m.saldo_final,
                m.metodo_pago,
                m.descripcion,
                m.fecha,
                c.tipo_moneda
            FROM mae_movimientos m
            JOIN mae_cuentas c ON m.cuenta_id = c.id
            WHERE m.cuenta_id = $1
            ORDER BY m.fecha DESC
            LIMIT 10`;
            
        const result = await client.query(query, [cuenta_id]);
        
        res.json({
            success: true,
            movimientos: result.rows.map(mov => ({
                ...mov,
                // Formatear fecha para el cliente
                fecha: new Date(mov.fecha).toISOString(),
                // Determinar el símbolo monetario
                simbolo: mov.tipo_moneda === 'PEN' ? 'S/' : '$'
            }))
        });
        
    } catch (error) {
        console.error('❌ Error al obtener movimientos:', error.stack);
        res.status(500).json({
            success: false,
            error: 'Error al obtener movimientos',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        client.release();
    }
});

// Función para generar número de cuenta
function generarNumeroCuenta(moneda) {
    const prefix = moneda === 'PEN' ? '191' : '192';
    const randomNum = Math.floor(100000000 + Math.random() * 900000000);
    return `${prefix}${randomNum}`;
}

// Manejo de rutas no encontradas
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Ruta no encontrada',
        suggestedRoutes: [
            { method: 'POST', path: '/registrar-cliente' },
            { method: 'POST', path: '/api/login' },
            { method: 'POST', path: '/api/crear-cuentas' },
            { method: 'GET', path: '/api/mae_cuentas-usuario?dni=12345678' }
        ]
    });
});

// Manejo de errores global
app.use((err, req, res, next) => {
    console.error('🔥 Error global no capturado:', err.stack);
    res.status(500).json({
        success: false,
        error: 'Error interno del servidor',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📚 Documentación API disponible en http://localhost:${PORT}/docs`);
});

// Manejo de cierre
process.on('SIGINT', () => {
    console.log('\n🛑 Recibida señal SIGINT. Cerrando servidor...');
    pool.end()
        .then(() => {
            console.log('✅ Conexiones de PostgreSQL cerradas');
            process.exit(0);
        })
        .catch(err => {
            console.error('❌ Error al cerrar conexiones:', err);
            process.exit(1);
        });
});

// Exportar para testing
if (process.env.NODE_ENV === 'test') {
    module.exports = { app, pool };
}