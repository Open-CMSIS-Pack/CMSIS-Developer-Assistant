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
#include <string.h>

static struct timeout_t timeout = {false, NULL};

typedef void (*led_handler_t)(unsigned int);

static void led_toggle(unsigned int state)
{
    set_led_port(state);
}

/* Handler table lives in RAM so it can be patched at run time. */
static led_handler_t handlers[2];
static uint32_t scratch[8];

static void handlers_init(void)
{
    handlers[0] = led_toggle;
    /* Slot 1 is filled from the scratch area by the host. */
    memset(scratch, 0xde, sizeof(scratch));
    handlers[1] = (led_handler_t)((uintptr_t)scratch | 1u);
}

__NO_RETURN int Blinky(uint32_t delay_ms)
{
    unsigned int led_state = 1;
    unsigned int tick = 0;

    stdout_init();
    printf("\r\n= Blinky is running =\r\n");

    led_port_init();
    handlers_init();
    timeout_init(&timeout, delay_ms);

    for (;;) {
        if (timeout_delay_is_elapsed(&timeout)) {
            led_state ^= 1;
            handlers[tick & 1](led_state);
            tick++;
            timeout_init(&timeout, delay_ms);
        }
    }
}
