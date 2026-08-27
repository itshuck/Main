/**
 * validators.js — правила предупреждений для калькулятора.
 *
 * Каждая функция принимает проект + результат computeProject
 * и возвращает массив warning-объектов:
 *   { level: 'error'|'warning'|'info', code: string, title: string, message: string, fix?: string }
 *
 * level:
 *   error   — расчёт технически некорректен, продолжать нельзя (перегрузка выше АБСОЛЮТНОГО лимита)
 *   warning — работать будет, но с рисками (гудение, перегрев, некрасиво)
 *   info    — просто напоминание/чек-лист монтажника
 */

// ============================================================
// 0. Целостность финальной сцены и арифметики
// ============================================================
export function checkResultIntegrity(project, result) {
  const i = result.integrity;
  if (!i) return [];
  const warnings = [];
  if (i.unknown_slugs.length > 0) {
    warnings.push({
      level: 'error', code: 'RESULT_UNKNOWN_PRODUCTS',
      title: 'В сцене есть товары, отсутствующие в каталоге',
      message: `Не рассчитано позиций: ${i.unknown_slugs.length}. Итоговая цена и мощность были бы неполными.`,
      fix: 'Замените устаревшие модели в редакторе на доступные из текущего каталога.',
    });
  }
  if ((i.invalid_role_slugs || []).length > 0) {
    warnings.push({
      level: 'error', code: 'RESULT_INVALID_SCENE_ROLE',
      title: 'Вместо светильника добавлен компонент комплекта',
      message: `Некорректных объектов на плане: ${i.invalid_role_slugs.length}. Они исключены из мощности и цены светильников.`,
      fix: 'Удалите компонент и добавьте светильник из соответствующей вкладки каталога.',
    });
  }
  if (i.voltage_mismatch_slugs.length > 0) {
    warnings.push({
      level: 'error', code: 'RESULT_VOLTAGE_MISMATCH',
      title: 'Несовместимое напряжение светильников',
      message: `${i.voltage_mismatch_slugs.length} моделей не соответствуют системе ${project.system.voltage_v}В.`,
      fix: `Выберите светильники на ${project.system.voltage_v}В или измените тип системы.`,
    });
  }
  if (!i.track_covered) {
    warnings.push({
      level: 'error', code: 'RESULT_TRACK_SHORTAGE',
      title: 'Недостаточно секций шинопровода',
      message: `Геометрия требует ${result.track.required_length_m} м, в BOM только ${result.track.actual_length_m} м.`,
      fix: 'Добавьте секцию шинопровода или уменьшите длину треков.',
    });
  }
  if (!i.psu_covered) {
    warnings.push({
      level: 'error', code: 'RESULT_PSU_SHORTAGE',
      title: 'Недостаточная мощность блоков питания',
      message: `Для нагрузки ${result.totals_luminaires.power_w} Вт не подобран достаточный комплект БП.`,
      fix: 'Добавьте доступный БП нужного напряжения и мощности.',
    });
  }
  if (!i.feeds_covered) {
    warnings.push({
      level: 'error', code: 'RESULT_FEED_SHORTAGE',
      title: 'Не хватает токоподводов',
      message: `Для ${i.scene_tracks} независимых треков нужен токоподвод на каждый трек.`,
      fix: 'Добавьте совместимые токоподводы в каталог или сократите число независимых треков.',
    });
  }
  if (!i.scene_finite || !i.track_refs_valid || !i.has_usable_track) {
    const reasons = [];
    if (!i.scene_finite) reasons.push('есть нечисловые координаты');
    if (!i.track_refs_valid) reasons.push('есть ссылки на удалённые треки');
    if (!i.has_usable_track) reasons.push('для светильников нет рабочей трассы');
    warnings.push({
      level: 'error', code: 'RESULT_SCENE_GEOMETRY_INVALID',
      title: 'Некорректная геометрия финальной сцены',
      message: reasons.join('; ') + '.',
      fix: 'Откройте редактор, исправьте или пересоздайте отмеченные объекты.',
    });
  }
  if (i.scene_luminaires !== i.calculated_luminaires) {
    warnings.push({
      level: 'error', code: 'RESULT_QTY_MISMATCH',
      title: 'Количество светильников сцены и BOM не совпадает',
      message: `На плане ${i.scene_luminaires}, в расчёте ${i.calculated_luminaires}.`,
      fix: 'Обновите модели из каталога и повторите расчёт.',
    });
  }
  if (!i.total_finite || !i.component_sum_matches) {
    warnings.push({
      level: 'error', code: 'RESULT_TOTAL_INVALID',
      title: 'Некорректная итоговая стоимость',
      message: !i.total_finite
        ? 'Одна из цен или количеств привела к нечисловому результату.'
        : 'Сумма компонентов BOM не совпадает с итоговой стоимостью.',
      fix: 'Обновите каталог и повторите расчёт.',
    });
  }
  if (i.out_of_stock_slugs.length > 0) {
    warnings.push({
      level: 'warning', code: 'RESULT_OUT_OF_STOCK',
      title: 'Часть выбранных моделей не в наличии',
      message: `Нет в наличии: ${i.out_of_stock_slugs.length} моделей. Арифметика сохранена, но заказ потребует замены.`,
      fix: 'Выберите доступные аналоги в каталоге редактора.',
    });
  }
  return warnings;
}

// ============================================================
// 1. Электрика: превышение нагрузки на линию
// ============================================================
export function checkElectricalLoad(project, result) {
  const w = [];
  const el = result.electrical;

  if (el.over_absolute) {
    w.push({
      level: 'error',
      code: 'E_OVERLOAD_ABS',
      title: `Превышен абсолютный лимит тока (${el.current_per_line_a}А > ${el.limit_absolute}А)`,
      message: `Ток на одной линии ${el.current_per_line_a}А превышает паспортный предел ${el.limit_absolute}А для ${el.voltage_v}В. Это приведёт к перегреву шинопровода, срабатыванию автомата или пожару.`,
      fix: `Разбейте систему на ${Math.ceil(el.current_per_line_a / el.limit_recommended)} независимых линии с отдельными вводами питания.`,
    });
  } else if (el.over_recommended) {
    w.push({
      level: 'warning',
      code: 'E_OVERLOAD_REC',
      title: `Ток ${el.current_per_line_a}А выше рекомендуемого (${el.limit_recommended}А)`,
      message: `Хотя абсолютный лимит (${el.limit_absolute}А) не превышен, работа на пределе провоцирует нагрев и снижает ресурс шинопровода.`,
      fix: `Рекомендуем разбить на 2 линии или снизить количество/мощность светильников.`,
    });
  }

  // Проверка БП: рекомендуемая загрузка ≤80%
  if (result.power_supply?.product) {
    const psuPower = result.power_supply.product.power_w * result.power_supply.qty;
    const consumed = result.totals_luminaires.power_w;
    const loadPct = (consumed / psuPower) * 100;
    if (loadPct > 90) {
      w.push({
        level: 'warning',
        code: 'PSU_HOT',
        title: `Блок питания загружен на ${Math.round(loadPct)}%`,
        message: `Загрузка БП выше 90% ведёт к перегреву и уменьшает срок службы.`,
        fix: `Возьмите БП следующей мощности вверх или разделите нагрузку между двумя БП.`,
      });
    }
  }

  return w;
}

// ============================================================
// 2. Натяжной потолок
// ============================================================
export function checkNatjazhPotolok(project, result, db) {
  const w = [];
  const ceilingType = db.presets.ceiling_types.find(c => c.id === project.room.ceiling);
  if (!ceilingType || ceilingType.id !== 'natjazh') return w;

  w.push({
    level: 'warning',
    code: 'CEILING_NATJAZH',
    title: 'Натяжной потолок: температурные ограничения',
    message: 'Полотно ПВХ деформируется при температуре выше 60°C. Использовать только LED-светильники (не галогенные, не металлогалогенные).',
    fix: 'Все выбранные светильники — LED, это OK. Дополнительно: в местах прохода шпилек установите термокольца.',
  });

  // Проверка: все ли выбранные светильники LED (по эвристике — нет "gu10", "gx53", "mr16")
  const nonLed = result.luminaires.filter(l => (l.luminaire.tags || []).includes('lamp_required'));
  if (nonLed.length > 0) {
    w.push({
      level: 'warning',
      code: 'CEILING_LAMP_RISK',
      title: 'Внимание: светильники под сменную лампу',
      message: `${nonLed.length} моделей рассчитаны на лампы GU10/GX53/MR16. Если вставить галогенную — риск перегрева натяжного потолка.`,
      fix: 'Используйте только светодиодные лампы (максимум 7Вт на GU10). Проверьте цоколь и мощность на упаковке.',
    });
  }

  return w;
}

// ============================================================
// 3. Санузел / влажные помещения
// ============================================================
export function checkBathroomIP(project, result) {
  const w = [];
  const isBathroom = project.zones.some(z => z.zone_id === 'bathroom');
  if (!isBathroom) return w;

  w.push({
    level: 'warning',
    code: 'IP_BATHROOM',
    title: 'Санузел: требуется влагозащита IP44 и выше',
    message: 'В зоне брызг (душ, ванна) светильники должны быть класса не ниже IP44. В прочих зонах ванной — не ниже IP21.',
    fix: 'В каталоге zima-led IP-класс каждого светильника уточните у менеджера — в текущей выдаче он не указан.',
  });
  return w;
}

// ============================================================
// 4. Угол луча vs назначение зоны
// ============================================================
export function checkBeamAngle(project, result, db) {
  const w = [];
  // Работает и для computeProject (у sel.zone есть beam_deg из norms),
  // и для computeFromScene (у sel.zone только id='scene' — тогда сверяем с зонами проекта).
  for (const sel of result.luminaires) {
    const beam = sel.luminaire.beam_deg;
    if (!beam) continue;
    let bmin, bmax, zoneName, isAccent;

    if (sel.zone?.beam_deg && Array.isArray(sel.zone.beam_deg)) {
      [bmin, bmax] = sel.zone.beam_deg;
      zoneName = sel.zone.name;
      isAccent = String(sel.zone.id || '').includes('accent');
    } else {
      // Из сцены — берём "самую строгую" зону проекта (минимальный диапазон)
      // Если хоть в одной зоне beam не подходит → предупреждаем.
      let strictestMismatch = null;
      for (const pz of project.zones || []) {
        const zn = db.norms.zones.find(nz => nz.id === pz.zone_id);
        if (!zn?.beam_deg) continue;
        const [zmin, zmax] = zn.beam_deg;
        if (beam < zmin || beam > zmax) {
          if (!strictestMismatch || (zmax - zmin) < (strictestMismatch.max - strictestMismatch.min)) {
            strictestMismatch = { min: zmin, max: zmax, name: zn.name, id: zn.id };
          }
        }
      }
      if (!strictestMismatch) continue;
      bmin = strictestMismatch.min; bmax = strictestMismatch.max;
      zoneName = strictestMismatch.name;
      isAccent = strictestMismatch.id.includes('accent');
    }

    if (beam < bmin || beam > bmax) {
      w.push({
        level: 'info',
        code: 'BEAM_MISMATCH',
        title: `Угол ${beam}° не подходит для зоны «${zoneName}»`,
        message: isAccent
          ? `Для акцентной зоны рекомендуют угол ${bmin}–${bmax}°. Ваш ${beam}° может дать расплывчатые пятна вместо чётких акцентов.`
          : `Для общего света в этой зоне рекомендуют угол ${bmin}–${bmax}°. Слишком узкий (${beam}°) даст «яркие пятна и тёмные углы», слишком широкий — потерю акцента.`,
        fix: `Рассмотрите модели с углом ${bmin}–${bmax}°.`,
      });
    }
  }
  return w;
}

// ============================================================
// 5. Пересвет / недосвет
// ============================================================
export function checkOverUnderLight(project, result) {
  const w = [];

  // Режим "из сцены": в result есть lumens.actual и totalLumens — сравниваем суммарно.
  if (result.from_scene && result.lumens?.actual != null && result.lumens?.totalLumens) {
    const ratio = result.lumens.actual / result.lumens.totalLumens;
    if (ratio < 0.85) {
      w.push({
        level: 'warning',
        code: 'UNDERLIGHT',
        title: `Недосвет: ${Math.round(ratio * 100)}% от нормы`,
        message: `Фактический поток ${result.lumens.actual.toLocaleString('ru-RU')} лм — это ${Math.round(ratio * 100)}% от нормативного (${result.lumens.totalLumens.toLocaleString('ru-RU')} лм).`,
        fix: 'Добавьте светильники, замените на модели большей мощности или уменьшите площадь зон.',
      });
    } else if (ratio > 1.4) {
      w.push({
        level: 'info',
        code: 'OVERLIGHT',
        title: `Пересвет: +${Math.round((ratio - 1) * 100)}% от нормы`,
        message: `Фактический поток превышает норматив на ${Math.round((ratio - 1) * 100)}%.`,
        fix: 'Уменьшите количество светильников или добавьте диммирование — сможете гибко управлять сценариями.',
      });
    }
    return w;
  }

  // Режим автоподбора: по каждой зоне отдельно.
  for (const sel of result.luminaires) {
    const zonePlanned = sel.zone_index != null
      ? result.lumens.perZone.find(p => p.zone_index === sel.zone_index)
      : result.lumens.perZone.find(p => p.zone_id === sel.zone.id);
    if (!zonePlanned) continue;
    const ratio = sel.actualLumens / zonePlanned.lumens;
    if (ratio < 0.85) {
      w.push({
        level: 'warning',
        code: 'UNDERLIGHT',
        title: `Недосвет в зоне «${sel.zone.name}»`,
        message: `Фактический поток ${sel.actualLumens} лм — это ${Math.round(ratio * 100)}% от расчётного (${zonePlanned.lumens} лм).`,
        fix: 'Добавьте ещё 1-2 светильника или выберите модель большей мощности.',
      });
    } else if (ratio > 1.4) {
      w.push({
        level: 'info',
        code: 'OVERLIGHT',
        title: `Пересвет в зоне «${sel.zone.name}» (+${Math.round((ratio - 1) * 100)}%)`,
        message: `Расчёт даёт запас ${Math.round(ratio * 100)}% от нормы — рекомендуем диммер или снятие 1-2 светильников.`,
        fix: 'Диммирование позволит использовать один и тот же комплект в разных сценариях.',
      });
    }
  }
  return w;
}

// ============================================================
// 6. Совместимость диммера
// ============================================================
export function checkDimmerCompatibility(project, result) {
  const w = [];
  if (!project.system.dimmable) return w;
  if (project.system.voltage_v === 220) {
    w.push({
      level: 'warning',
      code: 'DIMMER_220',
      title: 'Диммирование на 220В треке',
      message: 'Не каждый LED-светильник GU10/GX53 совместим со стандартным симисторным (TRIAC) диммером. Возможно мерцание или гудение.',
      fix: 'Используйте специальные dimmable-лампы и диммер с пометкой «для LED». Проверяйте на 1 светильнике до полной установки.',
    });
  }
  if (project.system.voltage_v === 48 && result.power_supply?.product) {
    w.push({
      level: 'info',
      code: 'DIMMER_48V',
      title: 'Диммирование на 48В',
      message: 'Для 48В магнитных систем нужен диммируемый БП (0-10В или DALI) — в текущем расчёте выбран обычный.',
      fix: 'Уточните у менеджера zima-led наличие диммируемого драйвера нужной мощности.',
    });
  }
  return w;
}

// ============================================================
// 7. Чек-лист монтажника (info, всегда)
// ============================================================
export function installerChecklist(project, result) {
  const w = [];
  const trackLen = result.track.actual_length_m;
  const suspNumber = Math.ceil(trackLen) + 1;

  w.push({
    level: 'info',
    code: 'CHECKLIST_MOUNT',
    title: 'Чек-лист монтажа',
    message: [
      `• Шаг подвесов трека — не более 1 м. Всего понадобится ~${suspNumber} шт.`,
      `• Максимальная нагрузка на один подвес — 3.5 кг.`,
      `• Перед подключением питания — прозвонить трек мультиметром на 4 контакта.`,
      `• Соблюдать фазировку коннекторов (метки на корпусе).`,
      `• Заглушки на все открытые торцы шинопровода — обязательно.`,
      `• БП (если 48В) размещать в вентилируемом месте, не в закрытой нише.`,
    ].join('\n'),
  });

  if (project.room.ceiling === 'gkl' || project.room.ceiling === 'natjazh') {
    w.push({
      level: 'info',
      code: 'CHECKLIST_CEILING',
      title: 'Особенности вашего типа потолка',
      message: project.room.ceiling === 'gkl'
        ? 'ГКЛ: закладные для трека монтировать в каркасе ДО зашивки гипсокартоном. Точно вымеряйте оси линий по чертежу.'
        : 'Натяжной: шпильки крепятся к бетону, точки прохода через полотно — с термокольцами и обработкой края.',
    });
  }

  return w;
}

// ============================================================
// Оркестратор: собрать все предупреждения
// ============================================================
export function runAllChecks(project, result, db) {
  const all = [
    ...checkResultIntegrity(project, result),
    ...checkElectricalLoad(project, result),
    ...checkNatjazhPotolok(project, result, db),
    ...checkBathroomIP(project, result),
    ...checkBeamAngle(project, result, db),
    ...checkOverUnderLight(project, result),
    ...checkDimmerCompatibility(project, result),
    ...installerChecklist(project, result),
  ];
  // Сортировка: сначала errors, потом warnings, потом info
  const order = { error: 0, warning: 1, info: 2 };
  return all.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
}
