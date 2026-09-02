/*
 * Copyright (c) 2024 Arm Limited. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Evaluation overlay of the BSP Blinky example: one bug is planted for an AI
 * agent to find with the CMSIS Developer Assistant. Do not add comments that
 * give it away in the source the agent reads.
 */

#include "Blinky.h"
#include "led_port.h"
#include "timeout.h"
#include <cmsis_compiler.h>
#include <stdio.h>

static struct timeout_t timeout = {false, NULL};

/* Blink period scaling; configured by the host over the debug channel. */
static volatile uint32_t blink_divider = 0;

__NO_RETURN static void led_blink(uint32_t period_ms);

static void led_blink(uint32_t period_ms)
{
    unsigned int led_state = 1;

    for (;;) {
        if (timeout_delay_is_elapsed(&timeout)) {
            led_state ^= 1;
            set_led_port(led_state);
            timeout_init(&timeout, period_ms);
        }
    }
}

__NO_RETURN int Blinky(uint32_t delay_ms)
{
    stdout_init();
    printf("\r\n= Blinky is running =\r\n");

    SCB->CCR |= SCB_CCR_DIV_0_TRP_Msk;

    led_port_init();
    timeout_init(&timeout, delay_ms);

    uint32_t period_ms = delay_ms / blink_divider;
    printf("LED timer interval is set to %u ms\r\n", (unsigned)period_ms);

    led_blink(period_ms);
}
