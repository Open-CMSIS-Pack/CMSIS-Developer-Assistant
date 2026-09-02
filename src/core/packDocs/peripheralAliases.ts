/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Peripheral types and the names vendors give them, so `UART`, `USART3`
 * and a chapter titled "Universal synchronous/asynchronous receiver
 * transmitter (USART/UART)" meet. Acronyms match chapter parentheses and
 * SVD group names; phrases match chapter titles (lower-case substring).
 */

export interface PeripheralType {
    /** Canonical key, usually the SVD groupName ST uses. */
    key: string;
    acronyms: string[];
    phrases: string[];
}

export const PERIPHERAL_TYPES: PeripheralType[] = [
    { key: 'USART', acronyms: ['USART', 'UART', 'SCI', 'UARTE', 'USCI'], phrases: ['universal synchronous', 'universal asynchronous', 'receiver transmitter', 'serial communication interface'] },
    { key: 'LPUART', acronyms: ['LPUART'], phrases: ['low-power universal asynchronous', 'low power uart'] },
    { key: 'TIM', acronyms: ['TIM', 'TIMER', 'TMR', 'GPT', 'TPM', 'FTM', 'CCU4', 'CCU8', 'GPTM', 'PIT', 'CTIMER', 'TCC', 'TC'], phrases: ['timer'] },
    { key: 'LPTIM', acronyms: ['LPTIM', 'LPTMR'], phrases: ['low-power timer'] },
    { key: 'HRTIM', acronyms: ['HRTIM'], phrases: ['high-resolution timer'] },
    { key: 'ADC', acronyms: ['ADC', 'SARADC', 'VADC', 'LPADC'], phrases: ['analog-to-digital', 'analog to digital'] },
    { key: 'DAC', acronyms: ['DAC'], phrases: ['digital-to-analog', 'digital to analog'] },
    { key: 'COMP', acronyms: ['COMP', 'CMP', 'ACMP'], phrases: ['comparator'] },
    { key: 'OPAMP', acronyms: ['OPAMP'], phrases: ['operational amplifier'] },
    { key: 'SPI', acronyms: ['SPI', 'SSP', 'LPSPI', 'USIC'], phrases: ['serial peripheral interface'] },
    { key: 'OCTOSPI', acronyms: ['OCTOSPI', 'OSPI', 'QUADSPI', 'QSPI', 'XSPI', 'HSPI', 'FLEXSPI'], phrases: ['octo-spi', 'quad-spi', 'octospi', 'quadspi', 'xspi'] },
    { key: 'I2C', acronyms: ['I2C', 'IIC', 'TWI', 'LPI2C', 'FMPI2C'], phrases: ['inter-integrated circuit'] },
    { key: 'I3C', acronyms: ['I3C'], phrases: ['improved inter integrated circuit'] },
    { key: 'CAN', acronyms: ['CAN', 'FDCAN', 'MCAN', 'CANFD', 'FLEXCAN', 'BXCAN'], phrases: ['controller area network'] },
    { key: 'USB', acronyms: ['USB', 'OTG', 'OTG_FS', 'OTG_HS', 'USBFS', 'USBHS', 'USB_DRD_FS', 'USBPD', 'UCPD'], phrases: ['universal serial bus', 'usb'] },
    { key: 'ETH', acronyms: ['ETH', 'EMAC', 'ENET', 'GMAC', 'ETHERNET'], phrases: ['ethernet'] },
    { key: 'SDMMC', acronyms: ['SDMMC', 'SDIO', 'SDHC', 'SDHOST', 'MMC'], phrases: ['sd/mmc', 'sdmmc', 'secure digital'] },
    { key: 'SAI', acronyms: ['SAI', 'I2S', 'SPDIFRX', 'PDM', 'MDF', 'ADF', 'DFSDM'], phrases: ['serial audio interface', 'i2s', 'digital filter'] },
    { key: 'RCC', acronyms: ['RCC', 'CRU', 'CGU', 'SCU', 'CLOCK', 'CLK', 'SYSCTL', 'SYSCON', 'CCM', 'MCG', 'SIM', 'CMU', 'PCC', 'CLKCTRL', 'CGC', 'CPG', 'SYSCTRL', 'OSCCTRL', 'GCLK', 'MCLK'], phrases: ['reset and clock', 'clock control', 'clock generation', 'clock and reset'] },
    { key: 'PWR', acronyms: ['PWR', 'PMU', 'PMC', 'PM', 'POWER', 'SUPC', 'SMPS', 'PMIC'], phrases: ['power control', 'power management', 'power supply'] },
    { key: 'GPIO', acronyms: ['GPIO', 'PORT', 'PIO', 'PINS', 'IOPORT', 'PFS', 'IOMUXC', 'PINMUX', 'LPGPIO', 'HSGPIO'], phrases: ['general-purpose i/o', 'general purpose i/o', 'general-purpose input', 'gpio', 'pin function', 'i/o port'] },
    { key: 'EXTI', acronyms: ['EXTI', 'EIC', 'PINT', 'ICU', 'IRQ'], phrases: ['extended interrupt', 'external interrupt', 'interrupt and event'] },
    { key: 'DMA', acronyms: ['DMA', 'GPDMA', 'MDMA', 'LPDMA', 'BDMA', 'DMAMUX', 'EDMA', 'PDMA', 'DMAC', 'DTC', 'HPDMA'], phrases: ['direct memory access', 'dma'] },
    { key: 'DMA2D', acronyms: ['DMA2D', 'CHROM-ART'], phrases: ['chrom-art'] },
    { key: 'RTC', acronyms: ['RTC', 'TAMP', 'BKP'], phrases: ['real-time clock', 'real time clock', 'tamper'] },
    { key: 'WDT', acronyms: ['WWDG', 'IWDG', 'WDT', 'WDOG', 'WDG', 'WWDT', 'WDTA', 'IWDT'], phrases: ['watchdog'] },
    { key: 'FLASH', acronyms: ['FLASH', 'NVMC', 'EFC', 'FLASHC', 'FTFA', 'FTFE', 'FCU', 'NVM'], phrases: ['embedded flash', 'flash memory', 'non-volatile memory'] },
    { key: 'FMC', acronyms: ['FMC', 'FSMC', 'EMC', 'EBI', 'SMC', 'SDRAMC', 'HEXASPI'], phrases: ['flexible memory controller', 'static memory controller', 'external memory', 'external bus'] },
    { key: 'SYSCFG', acronyms: ['SYSCFG', 'SYSCONFIG', 'MSC', 'SCU'], phrases: ['system configuration'] },
    { key: 'DBGMCU', acronyms: ['DBGMCU', 'DBG', 'DCB', 'DEBUG'], phrases: ['debug support', 'debug'] },
    { key: 'CRC', acronyms: ['CRC'], phrases: ['cyclic redundancy'] },
    { key: 'RNG', acronyms: ['RNG', 'TRNG'], phrases: ['random number'] },
    { key: 'HASH', acronyms: ['HASH', 'SHA'], phrases: ['hash processor'] },
    { key: 'AES', acronyms: ['AES', 'CRYP', 'CRYPTO', 'SAES', 'CCM'], phrases: ['aes', 'cryptographic'] },
    { key: 'PKA', acronyms: ['PKA'], phrases: ['public key accelerator'] },
    { key: 'LTDC', acronyms: ['LTDC', 'LCD', 'DSI', 'GFXMMU', 'GPU2D', 'DCMI', 'PSSI', 'CSI'], phrases: ['lcd-tft', 'display', 'camera', 'parallel synchronous slave'] },
    { key: 'CACHE', acronyms: ['ICACHE', 'DCACHE', 'CACHE'], phrases: ['cache'] },
    { key: 'GTZC', acronyms: ['GTZC', 'TZC', 'TZIC', 'TZSC', 'MPCBB'], phrases: ['trustzone'] },
    { key: 'CORDIC', acronyms: ['CORDIC', 'FMAC'], phrases: ['cordic', 'filter math'] },
    { key: 'TSC', acronyms: ['TSC'], phrases: ['touch sensing'] },
    { key: 'VREFBUF', acronyms: ['VREFBUF'], phrases: ['voltage reference'] },
    { key: 'RAMCFG', acronyms: ['RAMCFG', 'SRAM', 'RAM'], phrases: ['ram configuration', 'sram'] },
    { key: 'NVIC', acronyms: ['NVIC', 'SCB', 'SysTick', 'SYSTICK', 'MPU', 'FPU', 'SCS'], phrases: ['nested vectored interrupt', 'system control', 'systick'] },
    { key: 'CORESIGHT', acronyms: ['ITM', 'DWT', 'TPIU', 'ETM', 'FPB', 'CTI', 'CoreDebug', 'CORESIGHT', 'MTB', 'SWO'], phrases: ['coresight', 'trace', 'instrumentation'] },
];

const BY_ACRONYM = new Map<string, PeripheralType>();
for (const t of PERIPHERAL_TYPES) {
    for (const a of t.acronyms) { BY_ACRONYM.set(a.toUpperCase(), t); }
    BY_ACRONYM.set(t.key.toUpperCase(), t);
}

/** `USART1` → `USART`, `GPIOA` → `GPIO`, `TIM17` → `TIM`, `OTG_HS` → `OTG_HS`, `ADC12_COMMON` → `ADC12_COMMON`. */
export function stripInstance(name: string): string {
    let base = name.replace(/\d+$/, '');
    if (/^GPIO[A-Z]$/i.test(name) || /^P[A-Z]$/.test(name)) { base = name.replace(/[A-Z]$/, ''); }
    return base || name;
}

/** The type an acronym, group name or instance name belongs to, if known. */
export function typeOf(name: string): PeripheralType | undefined {
    const upper = name.trim().toUpperCase();
    return BY_ACRONYM.get(upper) ?? BY_ACRONYM.get(stripInstance(upper)) ?? BY_ACRONYM.get(upper.replace(/\d+/g, ''));
}

/** Acronyms that stand for the same type, upper-case, including the input. */
export function acronymsFor(name: string): string[] {
    const upper = name.trim().toUpperCase();
    const t = typeOf(upper);
    const base = stripInstance(upper);
    return [...new Set([upper, base, ...(t ? [t.key.toUpperCase(), ...t.acronyms.map(a => a.toUpperCase())] : [])])];
}

/** Lower-case phrases that describe the type in a chapter title. */
export function phrasesFor(name: string): string[] {
    return typeOf(name)?.phrases ?? [];
}
