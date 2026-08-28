/* Trimmed CMSIS-Core header in the shape of core_cm33.h, for the core-peripheral tests. */

typedef union
{
  struct
  {
    uint32_t _reserved0:28;
    uint32_t V:1;
  } b;
  uint32_t w;
} APSR_Type;

#define APSR_V_Pos                         28U
#define APSR_V_Msk                         (1UL << APSR_V_Pos)

typedef struct
{
  __IOM uint32_t ISER[16U];              /*!< Offset: 0x000 (R/W)  Interrupt Set Enable Register */
        uint32_t RESERVED0[16U];
  __IOM uint32_t ICER[16U];              /*!< Offset: 0x080 (R/W)  Interrupt Clear Enable Register */
        uint32_t RESERVED1[16U];
  __IOM uint8_t  IPR[496U];              /*!< Offset: 0x100 (R/W)  Interrupt Priority Register (8Bit wide) */
} NVIC_Type;

typedef struct
{
  __IM  uint32_t CPUID;                  /*!< Offset: 0x000 (R/ )  CPUID Base Register */
  __IOM uint32_t ICSR;                   /*!< Offset: 0x004 (R/W)  Interrupt Control and State Register */
  __IOM uint32_t VTOR;                   /*!< Offset: 0x008 (R/W)  Vector Table Offset Register */
  __IOM uint32_t AIRCR;                  /*!< Offset: 0x00C (R/W)  Application Interrupt and Reset Control Register */
        uint32_t RESERVED0[2U];
  __IOM uint8_t  SHPR[12U];              /*!< Offset: 0x018 (R/W)  System Handlers Priority Registers (4-7, 8-11, 12-15) */
} SCB_Type;

#define SCB_CPUID_IMPLEMENTER_Pos          24U                                            /*!< SCB CPUID: IMPLEMENTER Position */
#define SCB_CPUID_IMPLEMENTER_Msk          (0xFFUL << SCB_CPUID_IMPLEMENTER_Pos)          /*!< SCB CPUID: IMPLEMENTER Mask */
#define SCB_CPUID_REVISION_Pos              0U                                            /*!< SCB CPUID: REVISION Position */
#define SCB_CPUID_REVISION_Msk             (0xFUL /*<< SCB_CPUID_REVISION_Pos*/)          /*!< SCB CPUID: REVISION Mask */
#define SCB_ICSR_PENDSVCLR_Pos             27U                                            /*!< SCB ICSR: PENDSVCLR Position */
#define SCB_ICSR_PENDSVCLR_Msk             (1UL << SCB_ICSR_PENDSVCLR_Pos)                /*!< SCB ICSR: PENDSVCLR Mask */
#define SCB_ICSR_VECTACTIVE_Pos             0U                                            /*!< SCB ICSR: VECTACTIVE Position */
#define SCB_ICSR_VECTACTIVE_Msk            (0x1FFUL /*<< SCB_ICSR_VECTACTIVE_Pos*/)       /*!< SCB ICSR: VECTACTIVE Mask */
#define SCB_AIRCR_VECTKEY_Pos              16U                                            /*!< SCB AIRCR: VECTKEY Position */
#define SCB_AIRCR_VECTKEY_Msk              (0xFFFFUL << SCB_AIRCR_VECTKEY_Pos)            /*!< SCB AIRCR: VECTKEY Mask */
#define SCB_AIRCR_SYSRESETREQ_Pos           2U                                            /*!< SCB AIRCR: SYSRESETREQ Position */
#define SCB_AIRCR_SYSRESETREQ_Msk          (1UL << SCB_AIRCR_SYSRESETREQ_Pos)             /*!< SCB AIRCR: SYSRESETREQ Mask */

typedef struct
{
  __IOM uint32_t CTRL;                   /*!< Offset: 0x000 (R/W)  SysTick Control and Status Register */
  __IOM uint32_t LOAD;                   /*!< Offset: 0x004 (R/W)  SysTick Reload Value Register */
} SysTick_Type;

#define SysTick_CTRL_ENABLE_Pos             0U                                            /*!< SysTick CTRL: ENABLE Position */
#define SysTick_CTRL_ENABLE_Msk            (1UL /*<< SysTick_CTRL_ENABLE_Pos*/)           /*!< SysTick CTRL: ENABLE Mask */

typedef struct
{
  __IOM uint32_t CTRL;                   /*!< Offset: 0x000 (R/W)  Control Register */
  __IOM uint32_t COMP0;                  /*!< Offset: 0x020 (R/W)  Comparator Register 0 */
        uint32_t RESERVED0[1U];
  __IOM uint32_t FUNCTION0;              /*!< Offset: 0x028 (R/W)  Function Register 0 */
  __IOM uint32_t COMP1;                  /*!< Offset: 0x030 (R/W)  Comparator Register 1 */
        uint32_t RESERVED1[1U];
  __IOM uint32_t FUNCTION1;              /*!< Offset: 0x038 (R/W)  Function Register 1 */
} DWT_Type;

#define DWT_CTRL_NUMCOMP_Pos               28U                                            /*!< DWT CTRL: NUMCOMP Position */
#define DWT_CTRL_NUMCOMP_Msk               (0xFUL << DWT_CTRL_NUMCOMP_Pos)                /*!< DWT CTRL: NUMCOMP Mask */
#define DWT_FUNCTION_MATCH_Pos              0U                                            /*!< DWT FUNCTION: MATCH Position */
#define DWT_FUNCTION_MATCH_Msk             (0xFUL /*<< DWT_FUNCTION_MATCH_Pos*/)          /*!< DWT FUNCTION: MATCH Mask */

typedef struct
{
  __IOM uint32_t DHCSR;                  /*!< Offset: 0x000 (R/W)  Debug Halting Control and Status Register */
} DCB_Type;

#define DCB_DHCSR_C_DEBUGEN_Pos             0U                                            /*!< DCB DHCSR: C_DEBUGEN Position */
#define DCB_DHCSR_C_DEBUGEN_Msk            (0x1UL /*<< DCB_DHCSR_C_DEBUGEN_Pos*/)         /*!< DCB DHCSR: C_DEBUGEN Mask */

  #define SCS_BASE            (0xE000E000UL)                             /*!< System Control Space Base Address */
  #define DWT_BASE            (0xE0001000UL)                             /*!< DWT Base Address */
  #define DCB_BASE            (0xE000EDF0UL)                             /*!< DCB Base Address */
  #define SysTick_BASE        (SCS_BASE +  0x0010UL)                     /*!< SysTick Base Address */
  #define NVIC_BASE           (SCS_BASE +  0x0100UL)                     /*!< NVIC Base Address */
  #define SCB_BASE            (SCS_BASE +  0x0D00UL)                     /*!< System Control Block Base Address */

  #define SCB                 ((SCB_Type       *)     SCB_BASE         ) /*!< SCB configuration struct */
  #define SysTick             ((SysTick_Type   *)     SysTick_BASE     ) /*!< SysTick configuration struct */
  #define NVIC                ((NVIC_Type      *)     NVIC_BASE        ) /*!< NVIC configuration struct */
  #define DWT                 ((DWT_Type       *)     DWT_BASE         ) /*!< DWT configuration struct */
  #define DCB                 ((DCB_Type       *)     DCB_BASE         ) /*!< DCB configuration struct */

  #define SCS_BASE_NS         (0xE002E000UL)                             /*!< System Control Space Base Address (non-secure address space) */
  #define SCB_BASE_NS         (SCS_BASE_NS +  0x0D00UL)                  /*!< System Control Block Base Address (non-secure address space) */
  #define SCB_NS              ((SCB_Type       *)     SCB_BASE_NS      ) /*!< SCB configuration struct          (non-secure address space) */
