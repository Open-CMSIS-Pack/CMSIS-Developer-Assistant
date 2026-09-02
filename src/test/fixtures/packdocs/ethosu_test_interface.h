/* Trimmed Ethos-U driver interface header in the shape of ethosu55_interface.h, for the NPU tests. */

#define NPU_NAMESPACE npu

#define NPU_REG_ID 0x0000
#define NPU_REG_STATUS 0x0004
#define NPU_REG_CMD 0x0008
#define NPU_REG_QBASE 0x0010
#define NPU_REG_BASEP_BASE 0x0080
#define NPU_REG_BASEP_ARRLEN 0x0008
#define NPU_REG_PMCR 0x0180

struct id_r
{
#ifndef __cplusplus
    union
    {
        struct
        {
            uint32_t version_status : 4; // This is the version of the product
            uint32_t version_minor : 4;  // This is the n for the P part of an RnPn release number
            uint32_t version_major : 4;  // This is the n for the R part of an RnPn release number
            uint32_t product_major : 4;  // Product major ID number (unique per base product)
            uint32_t arch_patch_rev : 4; // This is the patch number of the architecture version a.b
            uint32_t
                arch_minor_rev : 8; // This is the minor architecture version number, b in the architecture version a.b
            uint32_t
                arch_major_rev : 4; // This is the major architecture version number, a in the architecture version a.b
        };
        uint32_t word;
    };
#else
  private:
    uint32_t word0;

  public:
    CONSTEXPR id_r() : word0(269500929) {}
#endif
};

struct status_r
{
#ifndef __cplusplus
    union
    {
        struct
        {
            uint32_t state : 1;      // NPU state, 0 = Stopped, 1 = Running
            uint32_t irq_raised : 1; // Raw IRQ status, 0 = IRQ not raised, 1 = IRQ raised. IRQ is cleared using command
                                     // register bit 1
            uint32_t
                bus_status : 1; // 0=OK, 1=Bus abort detected and processing halted
            uint32_t reset_status : 1; // Reset is ongoing and only this register can be read
            uint32_t cmd_parse_error : 1; // 0=No error 1=Command stream parsing error detected
            uint32_t cmd_end_reached : 1; // 0=Not reached, 1=Reached
            uint32_t pmu_irq_raised : 1;  // 0=No PMU IRQ, 1=PMU IRQ raised
            uint32_t wd_fault : 1; // Weight decoder state
            uint32_t ecc_fault : 1; // ECC state for internal RAMs
            uint32_t reserved0 : 2;
            uint32_t faulting_interface : 1; // Faulting interface on bus abort
            uint32_t faulting_channel : 4;  // Faulting channel on a bus abort
            uint32_t irq_history_mask : 16; // IRQ History mask
        };
        uint32_t word;
    };
#else
  private:
    uint32_t word0;
#endif
};

struct cmd_r
{
#ifndef __cplusplus
    union
    {
        struct
        {
            uint32_t transition_to_running_state : 1; // Write 1 to transition the NPU to running state. Writing 0 has
                                                      // no effect
            uint32_t clear_irq : 1; // Write 1 to clear the IRQ status in the STATUS register
            uint32_t clock_q_enable : 1;
            uint32_t power_q_enable : 1;
            uint32_t
                stop_request : 1; // Write 1 to this bit to request STOP after completing any already-started commands
            uint32_t reserved0 : 11;
            uint32_t reserved1 : 16;
        };
        uint32_t word;
    };
#else
  private:
    uint32_t word0;
#endif
};

struct pmcr_r
{
#ifndef __cplusplus
    union
    {
        struct
        {
            uint32_t cnt_en : 1;       // Enable counters
            uint32_t event_cnt_rst : 1; // Reset event counters
            uint32_t cycle_cnt_rst : 1; // Reset cycle counter
            uint32_t mask_en : 1;      // PMU can be enabled/disabled by command stream operation NPU_OP_PMU_MASK
            uint32_t reserved0 : 7;
            uint32_t num_event_cnt : 5; // Number of event counters
            uint32_t reserved1 : 16;
        };
        uint32_t word;
    };
#else
  private:
    uint32_t word0;
#endif
};
