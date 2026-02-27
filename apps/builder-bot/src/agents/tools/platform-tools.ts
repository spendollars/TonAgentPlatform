/**
 * Platform Tools — инструменты для оркестратора с нативным tool-calling
 *
 * Каждый инструмент — это функция которую AI может вызвать напрямую.
 * Оркестратор использует agentic loop: think → call_tool → observe → repeat (до 5 итераций)
 */

import { getDBTools } from './db-tools';
import { getRunnerAgent } from '../sub-agents/runner';
import { getCreatorAgent } from '../sub-agents/creator';
import { getEditorAgent } from '../sub-agents/editor';
import { getAnalystAgent } from '../sub-agents/analyst';
import { getMemoryManager } from '../../db/memory';
import { canCreateAgent, canGenerateForFree, trackGeneration } from '../../payments';
import { allAgentTemplates } from '../../agent-templates';
import { detectTriggerFromDescription } from '../sub-agents/creator';

// ── Типы инструментов ──────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
    }>;
    required?: string[];
  };
}

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  /** Краткое резюме для observation masking */
  summary?: string;
}

// ── Реестр инструментов ────────────────────────────────────────────────────

export const PLATFORM_TOOLS: ToolDefinition[] = [
  {
    name: 'list_agents',
    description: 'Получить список агентов пользователя с их статусом, типом триггера и описанием',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Фильтр: "active" — только активные, "inactive" — только неактивные, "all" — все',
          enum: ['active', 'inactive', 'all'],
        },
      },
    },
  },
  {
    name: 'get_agent_details',
    description: 'Получить детальную информацию об агенте: код, логи, статус выполнения',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'number', description: 'ID агента' },
        include_code: { type: 'boolean', description: 'Включить код агента в ответ' },
        include_logs: { type: 'boolean', description: 'Включить последние логи' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'create_agent',
    description: 'Создать нового AI-агента из текстового описания. Агент будет работать 24/7 на сервере.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Подробное описание что должен делать агент. Чем подробнее — тем лучше код.',
        },
        name: {
          type: 'string',
          description: 'Имя агента (опционально, будет сгенерировано автоматически)',
        },
        trigger_type: {
          type: 'string',
          description: 'Тип запуска: manual — вручную, scheduled — по расписанию',
          enum: ['manual', 'scheduled'],
        },
        interval_ms: {
          type: 'number',
          description: 'Интервал запуска в миллисекундах (для scheduled). Например: 3600000 = 1 час',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'run_agent',
    description: 'Запустить агента (однократно или активировать постоянный режим для scheduled)',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'number', description: 'ID агента для запуска' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'stop_agent',
    description: 'Остановить работающего агента',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'number', description: 'ID агента для остановки' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'edit_agent',
    description: 'Изменить код агента согласно запросу пользователя',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'number', description: 'ID агента для редактирования' },
        modification: {
          type: 'string',
          description: 'Описание изменений которые нужно внести в код агента',
        },
      },
      required: ['agent_id', 'modification'],
    },
  },
  {
    name: 'delete_agent',
    description: 'Удалить агента навсегда',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'number', description: 'ID агента для удаления' },
        confirmed: {
          type: 'boolean',
          description: 'true — подтверждение удаления (требуется явное согласие пользователя)',
        },
      },
      required: ['agent_id', 'confirmed'],
    },
  },
  {
    name: 'explain_agent',
    description: 'Объяснить что делает агент простым языком',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'number', description: 'ID агента для объяснения' },
        question: {
          type: 'string',
          description: 'Конкретный вопрос об агенте (опционально)',
        },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'debug_agent',
    description: 'Найти ошибки и проблемы в коде агента',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'number', description: 'ID агента для отладки' },
        error_message: {
          type: 'string',
          description: 'Сообщение об ошибке если есть (опционально)',
        },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'get_agent_logs',
    description: 'Получить логи выполнения агента',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'number', description: 'ID агента' },
        limit: { type: 'number', description: 'Количество последних записей (по умолчанию 20)' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'get_ton_price',
    description: 'Получить текущую цену TON в USD с CoinGecko',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_ton_balance',
    description: 'Получить баланс TON-кошелька',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Адрес TON-кошелька (EQ... или UQ...)' },
      },
      required: ['address'],
    },
  },
  {
    name: 'get_nft_collection',
    description: 'Получить данные NFT-коллекции: floor price, количество items, holders',
    parameters: {
      type: 'object',
      properties: {
        collection_name: {
          type: 'string',
          description: 'Название коллекции (например: "TON Punks", "TON Diamonds")',
        },
        collection_address: {
          type: 'string',
          description: 'Адрес коллекции (EQ...) — если известен',
        },
      },
    },
  },
  {
    name: 'dex_quote',
    description: 'Получить котировку обмена токенов на DEX (STON.fi и DeDust параллельно, выбирает лучший курс)',
    parameters: {
      type: 'object',
      properties: {
        from_token: { type: 'string', description: 'Токен для продажи (например: "TON", "USDT")' },
        to_token: { type: 'string', description: 'Токен для покупки (например: "USDT", "NOT")' },
        amount: { type: 'number', description: 'Количество токенов для обмена' },
      },
      required: ['from_token', 'to_token', 'amount'],
    },
  },
  {
    name: 'web_search',
    description: 'Поиск актуальной информации в интернете (новости, цены, события)',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос' },
        max_results: { type: 'number', description: 'Максимум результатов (по умолчанию 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_platform_stats',
    description: 'Получить статистику платформы: количество агентов, активных агентов, пользователей',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_templates',
    description: 'Показать доступные шаблоны агентов для быстрого создания',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Категория шаблонов (опционально)',
        },
      },
    },
  },
];

// ── Исполнитель инструментов ───────────────────────────────────────────────

export class PlatformToolExecutor {
  constructor(private userId: number) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case 'list_agents':
          return this.listAgents(call.arguments);
        case 'get_agent_details':
          return this.getAgentDetails(call.arguments);
        case 'create_agent':
          return this.createAgent(call.arguments);
        case 'run_agent':
          return this.runAgent(call.arguments);
        case 'stop_agent':
          return this.stopAgent(call.arguments);
        case 'edit_agent':
          return this.editAgent(call.arguments);
        case 'delete_agent':
          return this.deleteAgent(call.arguments);
        case 'explain_agent':
          return this.explainAgent(call.arguments);
        case 'debug_agent':
          return this.debugAgent(call.arguments);
        case 'get_agent_logs':
          return this.getAgentLogs(call.arguments);
        case 'get_ton_price':
          return this.getTonPrice();
        case 'get_ton_balance':
          return this.getTonBalance(call.arguments);
        case 'get_nft_collection':
          return this.getNFTCollection(call.arguments);
        case 'dex_quote':
          return this.getDexQuote(call.arguments);
        case 'web_search':
          return this.webSearch(call.arguments);
        case 'get_platform_stats':
          return this.getPlatformStats();
        case 'list_templates':
          return this.listTemplates(call.arguments);
        default:
          return { success: false, error: `Unknown tool: ${call.name}` };
      }
    } catch (err: any) {
      return {
        success: false,
        error: `Tool ${call.name} failed: ${err?.message || String(err)}`,
      };
    }
  }

  // ── Реализации инструментов ──────────────────────────────────────────────

  private async listAgents(args: any): Promise<ToolResult> {
    const result = await getDBTools().getUserAgents(this.userId);
    if (!result.success) return { success: false, error: result.error };

    let agents = result.data || [];
    if (args.filter === 'active') agents = agents.filter(a => a.isActive);
    if (args.filter === 'inactive') agents = agents.filter(a => !a.isActive);

    const formatted = agents.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description?.slice(0, 100),
      isActive: a.isActive,
      triggerType: a.triggerType,
      triggerConfig: a.triggerConfig,
    }));

    return {
      success: true,
      data: formatted,
      summary: `${agents.length} агентов (${agents.filter(a => a.isActive).length} активных)`,
    };
  }

  private async getAgentDetails(args: any): Promise<ToolResult> {
    const agentResult = await getDBTools().getAgent(args.agent_id, this.userId);
    if (!agentResult.success) return { success: false, error: agentResult.error };

    const agent = agentResult.data!;
    const data: any = {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      isActive: agent.isActive,
      triggerType: agent.triggerType,
      triggerConfig: agent.triggerConfig,
      createdAt: agent.createdAt,
    };

    if (args.include_code) {
      data.code = agent.code;
    }

    if (args.include_logs) {
      const logsResult = await getRunnerAgent().getLogs(args.agent_id, this.userId, 10);
      if (logsResult.success) {
        data.recentLogs = logsResult.data?.logs.slice(-10);
      }
    }

    return {
      success: true,
      data,
      summary: `Агент #${agent.id} "${agent.name}" — ${agent.isActive ? 'активен' : 'остановлен'}`,
    };
  }

  private async createAgent(args: any): Promise<ToolResult> {
    // Проверяем лимиты
    const agentsList = await getDBTools().getUserAgents(this.userId);
    const currentCount = agentsList.data?.length ?? 0;
    const check = await canCreateAgent(this.userId, currentCount);
    if (!check.allowed) {
      return { success: false, error: `Лимит агентов: ${check.reason}` };
    }

    const genCheck = await canGenerateForFree(this.userId);
    if (!genCheck.allowed) {
      return {
        success: false,
        error: `Лимит генераций AI исчерпан. Цена: ${genCheck.pricePerGeneration} TON за генерацию`,
      };
    }

    // Проверяем шаблоны
    const desc = args.description;
    const matchedTemplate = this.matchTemplate(desc);
    if (matchedTemplate) {
      // ── Извлекаем параметры из описания для шаблонов ──────────────────────
      const extractedConfig: Record<string, string> = {};

      // Для NFT шаблонов — извлекаем название коллекции из описания
      if (matchedTemplate.id === 'nft-floor-predictor' || matchedTemplate.id === 'nft-floor-monitor') {
        // Ищем название коллекции в описании (слова с заглавной буквы или в кавычках)
        const quotedMatch = desc.match(/["«»""]([^"«»""]+)["«»""]/);
        const capitalMatch = desc.match(/(?:коллекц[а-яё]+\s+|collection\s+|следи за\s+|monitor\s+)([A-ZА-Я][A-Za-zА-Яа-я0-9\s]+?)(?:\s+и|\s+каждый|\s+каждые|\s+every|\s*$)/i);
        const collectionName = quotedMatch?.[1] || capitalMatch?.[1]?.trim();
        if (collectionName && collectionName.length > 2 && collectionName.length < 60) {
          extractedConfig['COLLECTION_NAME'] = collectionName;
        }
      }

      const baseConfig = matchedTemplate.triggerConfig.config || {};
      const triggerConfig = {
        ...(args.interval_ms
          ? { ...matchedTemplate.triggerConfig, intervalMs: args.interval_ms }
          : matchedTemplate.triggerConfig),
        config: { ...baseConfig, ...extractedConfig },
      };

      // Имя агента включает название коллекции если извлечена
      const agentName = args.name ||
        (extractedConfig['COLLECTION_NAME']
          ? `${extractedConfig['COLLECTION_NAME']} Price Monitor`
          : matchedTemplate.name);

      const createResult = await getDBTools().createAgent({
        userId: this.userId,
        name: agentName,
        description: desc,
        code: matchedTemplate.code,
        triggerType: args.trigger_type || matchedTemplate.triggerType,
        triggerConfig,
        isActive: false,
      });

      if (!createResult.success) return { success: false, error: createResult.error };
      trackGeneration(this.userId);

      return {
        success: true,
        data: {
          agentId: createResult.data!.id,
          name: createResult.data!.name,
          fromTemplate: true,
          templateId: matchedTemplate.id,
          triggerType: args.trigger_type || matchedTemplate.triggerType,
          triggerConfig,
          placeholders: matchedTemplate.placeholders,
          extractedConfig,
        },
        summary: `Агент #${createResult.data!.id} "${createResult.data!.name}" создан из шаблона${extractedConfig['COLLECTION_NAME'] ? ` (коллекция: ${extractedConfig['COLLECTION_NAME']})` : ''}`,
      };
    }

    // AI-генерация
    const detected = detectTriggerFromDescription(desc);
    const triggerType = args.trigger_type || detected.triggerType;
    const triggerConfig = args.interval_ms
      ? { intervalMs: args.interval_ms }
      : detected.triggerConfig;

    const result = await getCreatorAgent().createAgent({
      userId: this.userId,
      description: desc,
      name: args.name,
      triggerType,
      triggerConfig,
    });

    if (!result.success) return { success: false, error: result.error };
    trackGeneration(this.userId);

    const data = result.data!;
    if (!data.success) {
      return { success: false, error: data.message };
    }

    return {
      success: true,
      data: {
        agentId: data.agentId,
        name: data.name,
        explanation: data.explanation,
        securityScore: data.securityScore,
        triggerType: data.triggerType,
        triggerConfig: data.triggerConfig,
        placeholders: data.placeholders,
        autoStart: data.autoStart,
      },
      summary: `Агент #${data.agentId} "${data.name}" создан (безопасность: ${data.securityScore}/100)`,
    };
  }

  private async runAgent(args: any): Promise<ToolResult> {
    const result = await getRunnerAgent().runAgent({
      agentId: args.agent_id,
      userId: this.userId,
    });

    if (!result.success) return { success: false, error: result.error };

    const data = result.data!;
    return {
      success: true,
      data: {
        agentId: args.agent_id,
        isScheduled: data.isScheduled,
        intervalMs: data.intervalMs,
        executionResult: data.executionResult
          ? {
              success: data.executionResult.success,
              executionTime: data.executionResult.executionTime,
              logsCount: data.executionResult.logs?.length || 0,
              result: data.executionResult.result,
            }
          : undefined,
        message: data.message,
      },
      summary: data.isScheduled
        ? `Агент #${args.agent_id} запущен в постоянном режиме`
        : `Агент #${args.agent_id} выполнен (${data.executionResult?.success ? 'успешно' : 'с ошибкой'})`,
    };
  }

  private async stopAgent(args: any): Promise<ToolResult> {
    const result = await getRunnerAgent().pauseAgent(args.agent_id, this.userId);
    if (!result.success) return { success: false, error: result.error };

    return {
      success: true,
      data: { agentId: args.agent_id, stopped: true },
      summary: `Агент #${args.agent_id} остановлен`,
    };
  }

  private async editAgent(args: any): Promise<ToolResult> {
    const result = await getEditorAgent().modifyCode({
      userId: this.userId,
      agentId: args.agent_id,
      modificationRequest: args.modification,
    });

    if (!result.success) return { success: false, error: result.error };

    const data = result.data!;
    if (!data.success) return { success: false, error: data.message };

    return {
      success: true,
      data: {
        agentId: args.agent_id,
        changes: data.changes,
        securityScore: data.securityScore,
      },
      summary: `Агент #${args.agent_id} обновлён (безопасность: ${data.securityScore}/100)`,
    };
  }

  private async deleteAgent(args: any): Promise<ToolResult> {
    if (!args.confirmed) {
      return {
        success: false,
        error: 'Требуется подтверждение удаления (confirmed: true)',
      };
    }

    const result = await getDBTools().deleteAgent(args.agent_id, this.userId);
    if (!result.success) return { success: false, error: result.error };

    return {
      success: true,
      data: { agentId: args.agent_id, deleted: true },
      summary: `Агент #${args.agent_id} удалён`,
    };
  }

  private async explainAgent(args: any): Promise<ToolResult> {
    const result = await getAnalystAgent().explainAgent(
      args.agent_id,
      this.userId,
      args.question,
    );

    if (!result.success) return { success: false, error: result.error };

    return {
      success: true,
      data: { explanation: result.data?.content },
      summary: `Объяснение агента #${args.agent_id} готово`,
    };
  }

  private async debugAgent(args: any): Promise<ToolResult> {
    const codeResult = await getDBTools().getAgentCode(args.agent_id, this.userId);
    if (!codeResult.success) return { success: false, error: codeResult.error };

    const result = await getAnalystAgent().findBugs({
      code: codeResult.data!,
      errorMessage: args.error_message,
    });

    if (!result.success) return { success: false, error: result.error };

    return {
      success: true,
      data: {
        report: result.data?.content,
        threats: result.data?.threats,
      },
      summary: `Отладка агента #${args.agent_id}: ${result.data?.threats?.length || 0} проблем найдено`,
    };
  }

  private async getAgentLogs(args: any): Promise<ToolResult> {
    const limit = args.limit || 20;
    const result = await getRunnerAgent().getLogs(args.agent_id, this.userId, limit);
    if (!result.success) return { success: false, error: result.error };

    const logs = result.data?.logs || [];
    return {
      success: true,
      data: { logs },
      summary: `${logs.length} записей логов агента #${args.agent_id}`,
    };
  }

  private async getTonPrice(): Promise<ToolResult> {
    try {
      const resp = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd,rub',
        { headers: { Accept: 'application/json' } },
      );
      const data = (await resp.json()) as any;
      const usd = data?.['the-open-network']?.usd || 0;
      const rub = data?.['the-open-network']?.rub || 0;

      return {
        success: true,
        data: { usd, rub, timestamp: new Date().toISOString() },
        summary: `TON = $${usd} / ₽${rub}`,
      };
    } catch (e: any) {
      return { success: false, error: `Не удалось получить цену TON: ${e?.message}` };
    }
  }

  private async getTonBalance(args: any): Promise<ToolResult> {
    try {
      const addr = args.address;
      const resp = await fetch(
        `https://toncenter.com/api/v2/getAddressBalance?address=${encodeURIComponent(addr)}`,
        { headers: { Accept: 'application/json' } },
      );
      const data = (await resp.json()) as any;
      if (!data.ok) throw new Error(data.error || 'API error');

      const balanceTon = parseInt(data.result) / 1e9;
      return {
        success: true,
        data: { address: addr, balanceTon, balanceNano: data.result },
        summary: `Баланс ${addr.slice(0, 8)}...: ${balanceTon.toFixed(4)} TON`,
      };
    } catch (e: any) {
      return { success: false, error: `Ошибка получения баланса: ${e?.message}` };
    }
  }

  private async getNFTCollection(args: any): Promise<ToolResult> {
    try {
      const KNOWN: Record<string, string> = {
        'ton punks': 'EQAo92DYMokxghKcq-CkCGSk_MgXY5Fo1SPW20gkvZl75iCN',
        'tonpunks': 'EQAo92DYMokxghKcq-CkCGSk_MgXY5Fo1SPW20gkvZl75iCN',
        'ton diamonds': 'EQAG2BH0JlmFkbMrLEnyn2bIITaOSssd4WdisE4BdFMkZbir',
        'ton whales': 'EQAHOxMCdof3VJZC1jARSaTxXaTuBOElHcNfFAKl4ELjVFOG',
        'anonymous': 'EQAOQdwdw8kGftJCSFgOErM1mBjYPe4DBPq8-AhF6vr9si5N',
      };

      let address = args.collection_address;
      if (!address && args.collection_name) {
        const key = args.collection_name.toLowerCase();
        address = KNOWN[key] || KNOWN[Object.keys(KNOWN).find(k => key.includes(k)) || ''];
      }

      if (!address) {
        return { success: false, error: `Коллекция "${args.collection_name}" не найдена` };
      }

      // Конвертируем EQ → raw
      const rawAddr = this.eqToRaw(address);
      const TONAPI_KEY = process.env.TONAPI_KEY || '';
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...(TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {}),
      };

      const colResp = await fetch(`https://tonapi.io/v2/nfts/collections/${rawAddr}`, { headers });
      if (!colResp.ok) throw new Error(`TonAPI ${colResp.status}`);

      const colData = (await colResp.json()) as any;
      const name = colData?.metadata?.name || address.slice(0, 8);
      const itemsCount = colData?.next_item_index || 0;

      // Floor price из листингов
      let floorPrice = 0;
      const itemsResp = await fetch(
        `https://tonapi.io/v2/nfts/collections/${rawAddr}/items?limit=100`,
        { headers },
      );
      if (itemsResp.ok) {
        const itemsData = (await itemsResp.json()) as any;
        for (const item of itemsData.nft_items || []) {
          const val = item?.sale?.price?.value;
          if (val && parseInt(val) > 0) {
            const p = parseInt(val) / 1e9;
            if (floorPrice === 0 || p < floorPrice) floorPrice = p;
          }
        }
      }

      // TON price for USD conversion
      let tonUsd = 0;
      try {
        const priceResp = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
        );
        const priceData = (await priceResp.json()) as any;
        tonUsd = priceData?.['the-open-network']?.usd || 0;
      } catch {}

      return {
        success: true,
        data: {
          name,
          address,
          floorPrice,
          floorPriceUsd: tonUsd ? floorPrice * tonUsd : null,
          itemsCount,
          tonUsdPrice: tonUsd,
        },
        summary: `${name}: floor ${floorPrice} TON ($${(floorPrice * tonUsd).toFixed(0)}), items: ${itemsCount}`,
      };
    } catch (e: any) {
      return { success: false, error: `Ошибка получения данных NFT: ${e?.message}` };
    }
  }

  private async getDexQuote(args: any): Promise<ToolResult> {
    try {
      const { from_token, to_token, amount } = args;

      // Параллельные запросы к STON.fi и DeDust
      const [stonResult, dedustResult] = await Promise.allSettled([
        this.getStonFiQuote(from_token, to_token, amount),
        this.getDedustQuote(from_token, to_token, amount),
      ]);

      const quotes: Array<{ dex: string; outputAmount: number; rate: number; fee?: number }> = [];

      if (stonResult.status === 'fulfilled' && stonResult.value) {
        quotes.push({ dex: 'STON.fi', ...stonResult.value });
      }
      if (dedustResult.status === 'fulfilled' && dedustResult.value) {
        quotes.push({ dex: 'DeDust', ...dedustResult.value });
      }

      if (quotes.length === 0) {
        return { success: false, error: 'Не удалось получить котировки ни с одного DEX' };
      }

      // Сортируем по лучшему курсу
      quotes.sort((a, b) => b.outputAmount - a.outputAmount);
      const best = quotes[0];

      return {
        success: true,
        data: {
          fromToken: from_token,
          toToken: to_token,
          inputAmount: amount,
          quotes,
          bestDex: best.dex,
          bestOutput: best.outputAmount,
          bestRate: best.rate,
        },
        summary: `Лучший курс: ${best.dex} — ${amount} ${from_token} → ${best.outputAmount.toFixed(4)} ${to_token}`,
      };
    } catch (e: any) {
      return { success: false, error: `Ошибка DEX котировки: ${e?.message}` };
    }
  }

  private async getStonFiQuote(
    fromToken: string,
    toToken: string,
    amount: number,
  ): Promise<{ outputAmount: number; rate: number } | null> {
    try {
      // STON.fi API v1
      const TON_ADDR = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
      const USDT_ADDR = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

      const tokenMap: Record<string, string> = {
        TON: TON_ADDR,
        USDT: USDT_ADDR,
      };

      const from = tokenMap[fromToken.toUpperCase()] || fromToken;
      const to = tokenMap[toToken.toUpperCase()] || toToken;
      const amountNano = Math.floor(amount * 1e9).toString();

      const resp = await fetch(
        `https://api.ston.fi/v1/swap/simulate?offer_address=${from}&ask_address=${to}&units=${amountNano}&slippage_tolerance=0.01`,
        { headers: { Accept: 'application/json' } },
      );

      if (!resp.ok) return null;
      const data = (await resp.json()) as any;

      const outputAmount = parseInt(data.ask_units || '0') / 1e9;
      const rate = outputAmount / amount;

      return { outputAmount, rate };
    } catch {
      return null;
    }
  }

  private async getDedustQuote(
    fromToken: string,
    toToken: string,
    amount: number,
  ): Promise<{ outputAmount: number; rate: number } | null> {
    try {
      // DeDust API
      const resp = await fetch(
        `https://api.dedust.io/v2/pools?limit=50`,
        { headers: { Accept: 'application/json' } },
      );

      if (!resp.ok) return null;
      const pools = (await resp.json()) as any[];

      // Ищем пул с нужной парой
      const fromUpper = fromToken.toUpperCase();
      const toUpper = toToken.toUpperCase();

      const pool = pools.find(p => {
        const assets = p.assets || [];
        const symbols = assets.map((a: any) => a.metadata?.symbol?.toUpperCase() || '');
        return symbols.includes(fromUpper) && symbols.includes(toUpper);
      });

      if (!pool) return null;

      // Простая оценка по reserves
      const assets = pool.assets || [];
      const fromAsset = assets.find((a: any) => a.metadata?.symbol?.toUpperCase() === fromUpper);
      const toAsset = assets.find((a: any) => a.metadata?.symbol?.toUpperCase() === toUpper);

      if (!fromAsset || !toAsset) return null;

      const fromReserve = parseInt(fromAsset.reserve || '0') / 1e9;
      const toReserve = parseInt(toAsset.reserve || '0') / 1e9;

      if (fromReserve === 0) return null;

      // AMM formula: x * y = k
      const outputAmount = (toReserve * amount) / (fromReserve + amount);
      const rate = outputAmount / amount;

      return { outputAmount, rate };
    } catch {
      return null;
    }
  }

  private async webSearch(args: any): Promise<ToolResult> {
    try {
      const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
      const maxResults = args.max_results || 5;

      if (TAVILY_KEY) {
        // Tavily Search API
        const resp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TAVILY_KEY}`,
          },
          body: JSON.stringify({
            query: args.query,
            max_results: maxResults,
            search_depth: 'basic',
          }),
        });

        if (resp.ok) {
          const data = (await resp.json()) as any;
          const results = (data.results || []).map((r: any) => ({
            title: r.title,
            url: r.url,
            snippet: r.content?.slice(0, 300),
          }));

          return {
            success: true,
            data: { query: args.query, results },
            summary: `Найдено ${results.length} результатов для "${args.query}"`,
          };
        }
      }

      // Fallback: DuckDuckGo Instant Answer API
      const resp = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1&skip_disambig=1`,
        { headers: { Accept: 'application/json' } },
      );

      if (resp.ok) {
        const data = (await resp.json()) as any;
        const results: any[] = [];

        if (data.AbstractText) {
          results.push({
            title: data.Heading || args.query,
            url: data.AbstractURL,
            snippet: data.AbstractText.slice(0, 400),
          });
        }

        for (const topic of (data.RelatedTopics || []).slice(0, maxResults - 1)) {
          if (topic.Text) {
            results.push({
              title: topic.Text.slice(0, 80),
              url: topic.FirstURL,
              snippet: topic.Text.slice(0, 300),
            });
          }
        }

        return {
          success: true,
          data: { query: args.query, results },
          summary: `Найдено ${results.length} результатов для "${args.query}"`,
        };
      }

      return { success: false, error: 'Поиск недоступен' };
    } catch (e: any) {
      return { success: false, error: `Ошибка поиска: ${e?.message}` };
    }
  }

  private async getPlatformStats(): Promise<ToolResult> {
    try {
      const agentsResult = await getDBTools().getUserAgents(this.userId);
      const agents = agentsResult.data || [];
      const activeCount = agents.filter(a => a.isActive).length;

      const memHistory = await getMemoryManager().getConversationHistory(this.userId, 100);
      const createdCount = memHistory.filter(m => m.metadata?.type === 'agent_created_complete').length;

      return {
        success: true,
        data: {
          userAgents: agents.length,
          activeAgents: activeCount,
          totalCreated: createdCount,
        },
        summary: `${agents.length} агентов (${activeCount} активных)`,
      };
    } catch (e: any) {
      return { success: false, error: `Ошибка статистики: ${e?.message}` };
    }
  }

  private async listTemplates(args: any): Promise<ToolResult> {
    const templates = allAgentTemplates.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      icon: t.icon,
      triggerType: t.triggerType,
      placeholders: t.placeholders.map(p => p.name),
    }));

    return {
      success: true,
      data: { templates },
      summary: `${templates.length} шаблонов доступно`,
    };
  }

  // ── Вспомогательные методы ───────────────────────────────────────────────

  private eqToRaw(address: string): string {
    if (address.startsWith('0:')) return address;
    try {
      const s = address.replace(/-/g, '+').replace(/_/g, '/');
      const padded = s + '=='.slice(0, (4 - (s.length % 4)) % 4);
      const buf = Buffer.from(padded, 'base64');
      return `0:${buf.slice(2, 34).toString('hex')}`;
    } catch {
      return address;
    }
  }

  private matchTemplate(description: string) {
    const d = description.toLowerCase();
    if (/nft|floor\s*price|коллекц|getgems|punks|fragment\.com/.test(d)) {
      return allAgentTemplates.find(t => t.id === 'nft-floor-predictor') || null;
    }
    if (/цена\s+ton|курс\s+ton|ton.*price|price.*ton/.test(d) && !/баланс|wallet|кошел/.test(d)) {
      return allAgentTemplates.find(t => t.id === 'ton-price-monitor') || null;
    }
    if (/низк.*баланс|баланс.*низк|low.*balance|упал.*ниже|ниже.*ton/.test(d)) {
      return allAgentTemplates.find(t => t.id === 'low-balance-alert') || null;
    }
    if (/проверь.*баланс|баланс.*кошел|check.*balance/.test(d) && !/каждый|schedule|monitor/.test(d)) {
      return allAgentTemplates.find(t => t.id === 'ton-balance-checker') || null;
    }
    if (/сайт.*досту|uptime|website.*monitor|пинг.*сайт/.test(d)) {
      return allAgentTemplates.find(t => t.id === 'website-monitor') || null;
    }
    if (/погод|weather/.test(d)) {
      return allAgentTemplates.find(t => t.id === 'weather-notifier') || null;
    }
    if (/(каждый\s+день|ежедневн|daily).*(?:отчёт|отчет|report|ton)/.test(d)) {
      return allAgentTemplates.find(t => t.id === 'daily-ton-report') || null;
    }
    return null;
  }
}
