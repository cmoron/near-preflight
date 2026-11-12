// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Siblings of the red team's RedL1Trap.sol, deployed only on a local copy of Base (anvil). Each lets a
/// buyer sell only while something the simulation cannot reproduce is unchanged since its buy: in a
/// simulation it never changes, on the real chain it does.
abstract contract EnvTrapBase {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable owner;
    address public pair;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// What the holder's last buy from the pair saw.
    mapping(address => uint256) public stamp;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
        totalSupply = 1_000_000 ether;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address p) external {
        require(msg.sender == owner, "owner");
        pair = p;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    /// The value a sale must find unchanged since the buy.
    function _seen() internal virtual returns (uint256);

    function _move(address from, address to, uint256 value) internal {
        if (to == pair && pair != address(0)) {
            uint256 s = stamp[from];
            require(s == 0 || s == _seen(), "anti-bot: cooldown");
        }
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        if (from == pair && pair != address(0)) stamp[to] = _seen();
        emit Transfer(from, to, value);
    }
}

/// Keyed on an opcode: the base fee. A simulation reuses one base fee for every simulated block; on the
/// real chain it moves with demand, and a sale after any move reverts.
contract BaseFeeTrap is EnvTrapBase {
    constructor(string memory name_, string memory symbol_) EnvTrapBase(name_, symbol_) {}

    function _seen() internal view override returns (uint256) {
        return block.basefee;
    }
}

/// Reads the L1Block predeploy, which Base rewrites at the start of every real block and a simulation
/// never does: the (L1 origin number, sequence number) pair is unique per real L2 block.
contract L1Helper {
    function l2Block() external view returns (uint256) {
        (, bytes memory n) = address(0x4200000000000000000000000000000000000015).staticcall(abi.encodeWithSignature("number()"));
        (, bytes memory s) = address(0x4200000000000000000000000000000000000015).staticcall(abi.encodeWithSignature("sequenceNumber()"));
        return (abi.decode(n, (uint256)) << 64) | abi.decode(s, (uint256));
    }
}

/// RedL1Trap's check reached through a delegatecall to a helper whose address sits in storage: the
/// token's own code holds neither the predeploy's address nor any environment opcode.
contract HelperTrap is EnvTrapBase {
    address public helper;

    constructor(string memory name_, string memory symbol_, address helper_) EnvTrapBase(name_, symbol_) {
        helper = helper_;
    }

    function _seen() internal override returns (uint256) {
        (bool ok, bytes memory r) = helper.delegatecall(abi.encodeWithSignature("l2Block()"));
        require(ok, "helper");
        return abi.decode(r, (uint256));
    }
}
