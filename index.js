require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(cors())
app.use(express.json())

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// =============================================
// HEALTH CHECK
// =============================================
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FideliZap API', version: '1.0.0' })
})

// =============================================
// CONTATOS
// =============================================

// Listar todos os contatos
app.get('/api/contatos', async (req, res) => {
  try {
    const { search } = req.query
    let query = supabase
      .from('contatos')
      .select('*, clientes(total_compras, valor_total, segmento)')
      .order('created_at', { ascending: false })

    if (search) {
      query = query.ilike('nome', `%${search}%`)
    }

    const { data, error } = await query
    if (error) throw error
    res.json({ data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Criar contato
app.post('/api/contatos', async (req, res) => {
  try {
    const { nome, telefone, origem } = req.body
    if (!nome || !telefone || !origem) {
      return res.status(400).json({ error: 'nome, telefone e origem são obrigatórios' })
    }
    const { data, error } = await supabase
      .from('contatos')
      .insert({ nome, telefone, origem, status: 'Novo' })
      .select()
      .single()
    if (error) throw error
    res.status(201).json({ data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Buscar contato por ID
app.get('/api/contatos/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contatos')
      .select('*, clientes(*), compras(*)')
      .eq('id', req.params.id)
      .single()
    if (error) throw error
    res.json({ data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// =============================================
// CLIENTES + RFM
// =============================================

// Listar clientes com RFM
app.get('/api/clientes', async (req, res) => {
  try {
    const { segmento } = req.query
    let query = supabase
      .from('clientes')
      .select('*, contatos(nome, telefone, origem)')
      .order('monetario', { ascending: false })

    if (segmento) {
      query = query.eq('segmento', segmento)
    }

    const { data, error } = await query
    if (error) throw error
    res.json({ data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Resumo dos segmentos RFM
app.get('/api/clientes/segmentos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clientes')
      .select('segmento')
    if (error) throw error

    const counts = {}
    const segmentos = ['Campeões','Fiéis','Promissores','Em risco','Dormentes','Perdidos']
    segmentos.forEach(s => counts[s] = 0)
    data.forEach(c => {
      if (counts[c.segmento] !== undefined) counts[c.segmento]++
    })

    res.json({ data: counts })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Registrar compra e recalcular RFM
app.post('/api/clientes/:contatoId/compras', async (req, res) => {
  try {
    const { contatoId } = req.params
    const { valor, origem_campanha_id } = req.body

    // Registrar compra
    await supabase.from('compras').insert({ contato_id: contatoId, valor, origem_campanha_id })

    // Buscar todas as compras do cliente
    const { data: compras } = await supabase
      .from('compras')
      .select('valor, created_at')
      .eq('contato_id', contatoId)
      .order('created_at', { ascending: false })

    const total_compras = compras.length
    const valor_total = compras.reduce((sum, c) => sum + parseFloat(c.valor), 0)
    const ultima_compra = compras[0].created_at
    const recencia = Math.floor((new Date() - new Date(ultima_compra)) / (1000 * 60 * 60 * 24))

    // Calcular segmento RFM
    const segmento = calcularSegmento(recencia, total_compras, valor_total)

    // Atualizar ou criar registro de cliente
    const { data: existente } = await supabase
      .from('clientes')
      .select('id')
      .eq('contato_id', contatoId)
      .single()

    if (existente) {
      await supabase.from('clientes').update({
        total_compras, valor_total, ultima_compra, segmento,
        recencia, frequencia: total_compras, monetario: valor_total,
        updated_at: new Date().toISOString()
      }).eq('contato_id', contatoId)
    } else {
      await supabase.from('clientes').insert({
        contato_id: contatoId, total_compras, valor_total, ultima_compra,
        segmento, recencia, frequencia: total_compras, monetario: valor_total
      })
    }

    // Atualizar status do contato
    await supabase.from('contatos')
      .update({ status: valor_total > 1000 ? 'VIP' : 'Ativo' })
      .eq('id', contatoId)

    res.json({ segmento, total_compras, valor_total, recencia })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Algoritmo RFM
function calcularSegmento(recencia, frequencia, monetario) {
  if (recencia <= 30 && frequencia >= 8 && monetario >= 1000) return 'Campeões'
  if (recencia <= 60 && frequencia >= 4 && monetario >= 400) return 'Fiéis'
  if (recencia <= 30 && frequencia >= 1) return 'Promissores'
  if (recencia > 60 && recencia <= 90 && frequencia >= 3) return 'Em risco'
  if (recencia > 90 && recencia <= 180) return 'Dormentes'
  return 'Perdidos'
}

// =============================================
// CAMPANHAS
// =============================================

// Listar campanhas
app.get('/api/campanhas', async (req, res) => {
  try {
    const { status } = req.query
    let query = supabase
      .from('campanhas')
      .select('*')
      .order('data_envio', { ascending: true })

    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw error
    res.json({ data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Criar campanha
app.post('/api/campanhas', async (req, res) => {
  try {
    const { nome, segmento, template, mensagem, data_envio } = req.body
    if (!nome || !segmento || !mensagem || !data_envio) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' })
    }
    const { data, error } = await supabase
      .from('campanhas')
      .insert({ nome, segmento, template: template || 'custom', mensagem, data_envio, status: 'Agendada' })
      .select()
      .single()
    if (error) throw error
    res.status(201).json({ data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Cancelar campanha
app.patch('/api/campanhas/:id/cancelar', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campanhas')
      .update({ status: 'Cancelada' })
      .eq('id', req.params.id)
      .select()
      .single()
    if (error) throw error
    res.json({ data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// =============================================
// DASHBOARD — métricas
// =============================================
app.get('/api/dashboard', async (req, res) => {
  try {
    const [
      { count: totalContatos },
      { data: compras },
      { data: campanhas },
      { data: segmentos }
    ] = await Promise.all([
      supabase.from('contatos').select('*', { count: 'exact', head: true }),
      supabase.from('compras').select('valor, created_at'),
      supabase.from('campanhas').select('status, total_enviadas, receita_gerada'),
      supabase.from('clientes').select('segmento')
    ])

    const faturamento = compras?.reduce((s, c) => s + parseFloat(c.valor), 0) || 0
    const ticket_medio = compras?.length > 0 ? faturamento / compras.length : 0
    const campanhas_enviadas = campanhas?.filter(c => c.status === 'Enviada').length || 0
    const msgs_enviadas = campanhas?.reduce((s, c) => s + (c.total_enviadas || 0), 0) || 0
    const receita_campanhas = campanhas?.reduce((s, c) => s + parseFloat(c.receita_gerada || 0), 0) || 0

    const seg_counts = {}
    segmentos?.forEach(c => { seg_counts[c.segmento] = (seg_counts[c.segmento] || 0) + 1 })

    res.json({
      data: {
        total_contatos: totalContatos || 0,
        faturamento: faturamento.toFixed(2),
        ticket_medio: ticket_medio.toFixed(2),
        campanhas_enviadas,
        msgs_enviadas,
        receita_campanhas: receita_campanhas.toFixed(2),
        segmentos: seg_counts
      }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// =============================================
// START
// =============================================
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`✅ FideliZap API rodando na porta ${PORT}`)
})
