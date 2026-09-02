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
#include <stdint.h>

static struct timeout_t timeout = {false, NULL};

/* Wire-format frame from the host: 1 byte type, then a 32-bit LED mask. */
static uint8_t frame[8] = { 0x01, 0x01, 0x00, 0x00, 0x00, 0, 0, 0 };

static uint32_t frame_mask(const uint8_t *buf)
{
    return *(const uint32_t *)(buf + 1);
}

__NO_RETURN int Blinky(uint32_t delay_ms)
{
    stdout_init();
    printf("\r\n= Blinky is running =\r\n");

    SCB->CCR |= SCB_CCR_UNALIGN_TRP_Msk;

    led_port_init();
    timeout_init(&timeout, delay_ms);

    for (;;) {
        if (timeout_delay_is_elapsed(&timeout)) {
            set_led_port(frame_mask(frame));
            frame[1] ^= 1;
            timeout_init(&timeout, delay_ms);
        }
    }
}
